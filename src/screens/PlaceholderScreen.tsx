import { workspaceNav, type NavId } from '../app/navigation';
import './PlaceholderScreen.css';

const screenTitles = new Map<NavId, string>(
  workspaceNav.map((item) => [item.id, item.label]),
);

export function PlaceholderScreen({ screen }: { screen: NavId }) {
  const title = screenTitles.get(screen) ?? screen;
  return (
    <div className="placeholder-screen">
      <p className="placeholder-screen__title">{title}</p>
      <p className="placeholder-screen__note">
        This screen is planned for a later milestone.
      </p>
    </div>
  );
}
