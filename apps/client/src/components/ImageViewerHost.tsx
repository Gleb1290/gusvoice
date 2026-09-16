import { useImageViewer } from '../imageViewer';
import { Lightbox } from './Lightbox';

/**
 * Единственная точка, где рисуется картинка, открытая на весь экран не из чата (аватар в карточке
 * профиля). Монтируется один раз у корня приложения — почему именно там, а не внутри карточки,
 * написано в `imageViewer.ts`.
 */
export function ImageViewerHost() {
  const image = useImageViewer((s) => s.image);
  const close = useImageViewer((s) => s.close);
  if (!image) return null;
  return <Lightbox images={[image]} index={0} onClose={close} onIndex={() => {}} />;
}
