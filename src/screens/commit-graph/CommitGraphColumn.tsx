import type { CommitRow } from '../../types/repository';
import './CommitGraphColumn.css';

/** Lane colors from the design palette, cycling by lane index.
 *  Order matches the sidebar branch colors: indigo, purple, cyan, orange. */
const LANE_COLORS = [
  '#8b9dff', // accent (main)
  '#b59aff', // purple
  '#62cee7', // cyan
  '#edb675', // orange
  '#6dd6ad', // green
  '#e79098', // red
];

const LANE_SPACING = 14;
const LANE_X0 = 14;
export const ROW_HEIGHT = 40;

function laneX(lane: number): number {
  return LANE_X0 + lane * LANE_SPACING;
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/**
 * One row of the commit lane graph. Draws straight lines for continuing
 * lanes, half lines for lanes that start/end at this commit, curves to
 * parent lanes, and the commit dot. Lane elements carry an SVG `<title>`
 * so hovering a lane shows the branch it belongs to.
 */
export function CommitGraphColumn({
  row,
  laneNames,
}: {
  row: CommitRow;
  /** Lane index → branch name, for hover tooltips on the lane lines. */
  laneNames?: Map<number, string>;
}) {
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

  const laneTitle = (lane: number) => {
    const name = laneNames?.get(lane);
    return name ? `Branch: ${name}` : 'Branch lane';
  };

  return (
    <svg
      className="commit-graph__svg"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {/* Lanes passing straight through this row. The invisible wide line
          underneath is the hover hit-area that carries the branch tooltip. */}
      {continuing.map((lane) => (
        <g key={`v${lane}`}>
          <line
            x1={laneX(lane)}
            y1={0}
            x2={laneX(lane)}
            y2={ROW_HEIGHT}
            stroke="transparent"
            strokeWidth={9}
            className="commit-graph__hit"
          >
            <title>{laneTitle(lane)}</title>
          </line>
          <line
            x1={laneX(lane)}
            y1={0}
            x2={laneX(lane)}
            y2={ROW_HEIGHT}
            stroke={laneColor(lane)}
            strokeWidth={1.5}
          />
        </g>
      ))}

      {/* Lanes that collapse into this commit (merge): stop at the dot. */}
      {ending.map((lane) => {
        const d = `M ${laneX(lane)} 0 C ${laneX(lane)} ${middle - 8}, ${
          laneX(row.lane)
        } ${middle - 8}, ${laneX(row.lane)} ${middle}`;
        return (
          <g key={`e${lane}`}>
            <path d={d} fill="none" stroke="transparent" strokeWidth={9} className="commit-graph__hit">
              <title>{laneTitle(lane)}</title>
            </path>
            <path d={d} fill="none" stroke={laneColor(lane)} strokeWidth={1.5} />
          </g>
        );
      })}

      {/* Lanes spawned by this commit (branch parents): leave from the dot. */}
      {starting.map((lane) => {
        const d = `M ${laneX(row.lane)} ${middle} C ${laneX(row.lane)} ${
          middle + 8
        }, ${laneX(lane)} ${middle + 8}, ${laneX(lane)} ${ROW_HEIGHT}`;
        return (
          <g key={`s${lane}`}>
            <path d={d} fill="none" stroke="transparent" strokeWidth={9} className="commit-graph__hit">
              <title>{laneTitle(lane)}</title>
            </path>
            <path d={d} fill="none" stroke={laneColor(lane)} strokeWidth={1.5} />
          </g>
        );
      })}

      {/* The commit itself. */}
      <circle
        cx={laneX(row.lane)}
        cy={middle}
        r={row.isHead ? 5 : 4}
        fill={row.isHead ? '#e9ebf0' : laneColor(row.lane)}
        stroke={row.isHead ? laneColor(row.lane) : 'none'}
        strokeWidth={2}
      >
        <title>
          {`${row.shortOid} ${row.summary}${row.isHead ? ' · HEAD' : ''}`}
        </title>
      </circle>
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
