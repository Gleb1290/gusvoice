import { useStore } from '../store';
import { Icon, type IconName } from './Icon';

/**
 * Mobile-only bottom navigation (hidden on desktop via CSS). Three tabs — Каналы / ЛС /
 * Профиль — that switch the primary view and drop back to the list pane. Профиль opens its own
 * full-screen tab (design-step8 D3), lifted to the store so this can toggle it.
 */
export function MobileNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setMobilePane = useStore((s) => s.setMobilePane);
  const setMobileProfileOpen = useStore((s) => s.setMobileProfileOpen);
  const loadDms = useStore((s) => s.loadDms);
  const unreadDms = useStore((s) => s.unreadDms);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const mobileProfileOpen = useStore((s) => s.mobileProfileOpen);
  const off = !settingsOpen && !mobileProfileOpen;

  const tab = (key: string, icon: IconName, label: string, active: boolean, onClick: () => void, badge?: number) => (
    <button type="button" className={`mnav-tab ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="mnav-ico">
        <Icon name={icon} size={22} />
        {badge ? <span className="mnav-badge" /> : null}
      </span>
      <span className="mnav-label">{label}</span>
    </button>
  );

  return (
    <nav className="mobile-nav">
      {tab('channels', 'hash', 'Каналы', view === 'server' && off, () => {
        setView('server');
        setMobileProfileOpen(false);
        setMobilePane('list');
      })}
      {tab(
        'dms',
        'mail',
        'ЛС',
        view === 'dm' && off,
        () => {
          setView('dm');
          void loadDms();
          setMobileProfileOpen(false);
          setMobilePane('list');
        },
        unreadDms.length,
      )}
      {tab('profile', 'user', 'Профиль', mobileProfileOpen, () => setMobileProfileOpen(true))}
    </nav>
  );
}
