import { useStore } from '../store';
import { unreadOutsideArchive } from '../dmArchiveRules';
import { Icon, type IconName } from './Icon';

/**
 * Mobile-only bottom navigation (hidden on desktop via CSS). Three tabs — Серверы / Сообщения / Профиль — that switch
 * the primary view and drop back to the list pane. Профиль opens its own full-screen tab (design-step8 D3), lifted to
 * the store so this can toggle it.
 * Подписи и значки — макет раунда 11 `ListPhone` (решение 04.10; было «Каналы / ЛС», у первой решётка). Лента серверов
 * сверху есть только на вкладке «Серверы» — её прячет `MainLayout` (`.app.m-norail`).
 * #218: «Серверы» открывает ПОСЛЕДНИЙ открытый сервер (его каналы), список серверов — «Назад» в шапке каналов или повторное нажатие
 * на открытую вкладку; логика — `openServersTab` в сторе (тест оболочки подставляет только стор, поэтому здесь новых импортов нет).
 */
export function MobileNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setMobilePane = useStore((s) => s.setMobilePane);
  const openServersTab = useStore((s) => s.openServersTab);
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
        <Icon name={icon} size={24} />
        {/* Число непрочитанных бесед, как счётчик вкладки «Чаты» у Telegram Android (`MainTabsActivity.checkUnreadCount`,
            `TA/ui/MainTabsActivity.java:407`; рисует `GlassTabView`), а не точка. */}
        {badge ? <span className="mnav-badge">{badge}</span> : null}
      </span>
      <span className="mnav-label">{label}</span>
    </button>
  );

  return (
    <nav className="mobile-nav" aria-label="Разделы">
      {/* Стеклянная капсула вкладок, как Telegram Android 12.x (`MainTabsActivity`: `tabsView` + фон-капсула), #218. */}
      <div className="mnav-capsule">
        {tab('servers', 'users', 'Серверы', view === 'server' && off, () => openServersTab(view === 'server' && off))}
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
      </div>
    </nav>
  );
}
