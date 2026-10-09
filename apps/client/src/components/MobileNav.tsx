import { useStore } from '../store';
import { unreadOutsideArchive } from '../dmArchiveRules';
import { Icon, type IconName } from './Icon';

/**
 * Mobile-only bottom navigation (hidden on desktop via CSS). Three tabs — Серверы / Сообщения / Профиль — that switch
 * the primary view and drop back to the list pane. Профиль opens its own full-screen tab (design-step8 D3), lifted to
 * the store so this can toggle it.
 * Подписи и значки — макет раунда 11 `ListPhone` (решение 04.10; было «Каналы / ЛС», у первой решётка). Лента серверов
 * сверху есть только на вкладке «Серверы» — её прячет `MainLayout` (`.app.m-norail`).
 */
export function MobileNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setMobilePane = useStore((s) => s.setMobilePane);
  const setMobileProfileOpen = useStore((s) => s.setMobileProfileOpen);
  const loadDms = useStore((s) => s.loadDms);
  // Беседы архива в общий счётчик не входят (07.10, G41).
  const unreadDmsN = useStore((s) => unreadOutsideArchive(s.dms, s.unreadDms).length);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const mobileProfileOpen = useStore((s) => s.mobileProfileOpen);
  const off = !settingsOpen && !mobileProfileOpen;

  const tab = (key: string, icon: IconName, label: string, active: boolean, onClick: () => void, badge?: number) => (
    <button
      type="button"
      className={`mnav-tab ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="mnav-ico">
        <Icon name={icon} size={22} />
        {badge ? <span className="mnav-badge" /> : null}
      </span>
      <span className="mnav-label">{label}</span>
    </button>
  );

  return (
    <nav className="mobile-nav" aria-label="Разделы">
      {tab('servers', 'users', 'Серверы', view === 'server' && off, () => {
        setView('server');
        setMobileProfileOpen(false);
        setMobilePane('list');
      })}
      {tab(
        'dms',
        'mail',
        'Сообщения',
        view === 'dm' && off,
        () => {
          setView('dm');
          void loadDms();
          setMobileProfileOpen(false);
          setMobilePane('list');
        },
        unreadDmsN,
      )}
      {tab('profile', 'user', 'Профиль', mobileProfileOpen, () => setMobileProfileOpen(true))}
    </nav>
  );
}
