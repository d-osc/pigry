import type { CommitRow } from '../../types/repository';
import './CommitGraphColumn.css';

/** Lane colors from the design palette, cycling by lane index. */
const LANE_COLORS = [
  '#8b9dff', // accent
  '#6dd6ad', // green
  '#edb675', // orange
  '#62cee7', // cyan
  '#b59aff', // purple
  '#e79098', // red
];

const LANE_SPACING = 14;
const LANE_X0 = 14;
export const ROW_HEIGHT = 36;

function laneX(lane: number): number {
  return LANE_X0 + lane * LANE_SPACING;
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/**
 * One row of the commit lane graph. Draws straight lines for continuing
 * lanes, half lines for lanes that start/end at this commit, curves to
 * parent lanes, and the commit dot.
 */
export function CommitGraphColumn({ row }: { row: CommitRow }) {
  const width = Math.max(120, LANE_X0 + (maxLane(row) + 1) * LANE_SPACING + 10);
  const middle = ROW_HEIGHT / 2;

  const continuing = row.activeBefore.filter((lane) =>
    row.activeAfter.includes(lane),
  );
  const ending = row.activeBefore.filter(
    (lane) => !row.activeAfter.includes(lane) && lane !== row.lane,
  );
  const starting = row.activeAfter.filter(
    (lane) => !row.activeBefore.includes(lane) && lane !== row.lane,
  );

  return (
    <svg
      className="commit-graph__svg"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {/* Lanes passing straight through this row. */}
      {continuing.map((lane) => (
        <line
          key={`v${lane}`}
          x1={laneX(lane)}
          y1={0}
          x2={laneX(lane)}
          y2={ROW_HEIGHT}
          stroke={laneColor(lane)}
          strokeWidth={1.5}
        />
      ))}

      {/* Lanes that collapse into this commit (merge): stop at the dot. */}
      {ending.map((lane) => (
        <path
          key={`e${lane}`}
          d={`M ${laneX(lane)} 0 C ${laneX(lane)} ${middle - 8}, ${
            laneX(row.lane)
          } ${middle - 8}, ${laneX(row.lane)} ${middle}`}
          fill="none"
          stroke={laneColor(lane)}
          strokeWidth={1.5}
        />
      ))}

      {/* Lanes spawned by this commit (branch parents): leave from the dot. */}
      {starting.map((lane) => (
        <path
          key={`s${lane}`}
          d={`M ${laneX(row.lane)} ${middle} C ${laneX(row.lane)} ${
            middle + 8
          }, ${laneX(lane)} ${middle + 8}, ${laneX(lane)} ${ROW_HEIGHT}`}
          fill="none"
          stroke={laneColor(lane)}
          strokeWidth={1.5}
        />
      ))}

      {/* The commit itself. */}
      <circle
        cx={laneX(row.lane)}
        cy={middle}
        r={row.isHead ? 5 : 4}
        fill={row.isHead ? '#e9ebf0' : laneColor(row.lane)}
        stroke={row.isHead ? laneColor(row.lane) : 'none'}
        strokeWidth={2}
      />
    </svg>
  );
}

function maxLane(row: CommitRow): number {
  const candidates = [
    ...row.activeBefore,
    ...row.activeAfter,
    row.lane,
    ...row.parentLanes,
  ];
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}
