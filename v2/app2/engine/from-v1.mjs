import { GRID_ENGINE, layoutGrid, countAt } from '../../app/core/analysis/analyze.js';
import { effectiveGrid } from '../../app/core/songmap/songmap.js';
import { migrateSongMap } from '../../app/core/songmap/schema.js';
import { validateEngineResult } from './result.mjs';

// v1 keeps a structure estimate only if migrateSongMap accepts it; otherwise the screen ignores it.
function v1Structure(grid) {
  if (!grid.structure) return null;
  return migrateSongMap({ schemaVersion: 4, song: { name: '', size: 0, duration: grid.duration },
    analysis: { ...grid, warnings: grid.diagnostics?.warnings ?? grid.warnings ?? [] } }).analysis.structure;
}

// Input: analyze/buildGrid output, optionally with inferStructure's summary.
// Automatic view only: no song-name hints, user anchors or section restarts.
export function fromV1(grid) {
  const structure = v1Structure(grid);
  const display = effectiveGrid({ analysis: { ...grid, structure }, song: { duration: grid.duration },
    corrections: { manualTempo: null, oneAnchorTime: null } });
  const lay = layoutGrid(display);
  const offset = display.barPhase.offset;
  const beats = grid.beats.map(time => ({ time, beatConf: null }));
  const counts = grid.beats.map((time, i) => {
    const item = countAt(lay, time);
    if (item) return { count: item.count, barPos: (item.count - 1) % 4 + 1, reason: null };
    if (offset === null) return { count: null, barPos: null, reason: 'bar_uncertain' };
    return { count: null, barPos: ((i - offset) % 4 + 4) % 4 + 1,
      reason: 'eight_uncertain' };
  });
  const tempoInterp = grid.tempoFactor === 2 ? 'double' : grid.tempoFactor === .5 ? 'half' : 'normal';
  const segments = [];
  function append(start, end, reason) {
    if (end <= start) return;
    const previous = segments.at(-1);
    if (previous && previous.reason === reason && previous.end === start) { previous.end = end; return; }
    segments.push({ start, end, pulse: reason === 'no_pulse' ? 'absent' : 'present', reason,
      meter: reason === 'no_pulse' || reason === 'bar_uncertain' ? null : 4, tempoInterp,
      beatConf: null, tempoConf: null, barPhaseConf: null, eightPhaseConf: null });
  }
  if (!beats.length) append(0, grid.duration, 'no_pulse');
  else {
    append(0, beats[0].time, 'no_pulse');
    const last = beats.length - 1;
    // Same final-count horizon as v1 layoutGrid, including an unnumbered last beat.
    const stop = Math.min(grid.duration, beats[last].time +
      (last > 0 ? beats[last].time - beats[last - 1].time : .5));
    beats.forEach((b, i) => append(b.time, beats[i + 1]?.time ?? stop, counts[i].reason));
    append(stop, grid.duration, 'no_pulse');
  }
  const result = { engineVersion: `v1-grid:${grid.engine ?? GRID_ENGINE};structure:${structure?.model ?? 'none'}:${structure?.version ?? 0}`,
    duration: grid.duration, beats, counts, segments, restarts: [],
    // v1 summary does not expose calibrated probabilities or raw logits.
    scoreSummary: { beatLogits: null, downbeatLogits: null,
      diagnostics: structuredClone(grid.diagnostics ?? null) } };
  const validation = validateEngineResult(result);
  if (!validation.ok) throw new RangeError(validation.errors.join('; '));
  return result;
}
