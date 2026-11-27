/** Что показывает карточка: сервер, когда запустили, сколько дарили и сколько досталось мне. */
export interface GamesLaunchNotice {
  serverId: string;
  at: string;
  gift: number;
  mine: number;
  /** Повтор из «Активностей» («Что это у нас?», 29.10): показать, даже если видел, и без строки о подарке. */
  replay?: boolean;
}
