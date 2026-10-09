/**
 * 最小 UI bundle：任務列不用自己加（宿主依 manifest 給入口），這裡註冊
 * 1. 右側欄面板（plugin 模式開著時出現）——顯示結構數、按鈕把十字線推到原點；
 * 2. 一個 overlay painter——在每格畫一個小十字，示範 `api.overlay` 與 `project()`。
 *
 * 只 import `@rtgaia/sdk` 與 React；打包時四個 external 不進 bundle（vite.config.ts）。
 */

import { useEffect, useState } from 'react';
import { registerModule, type OverlayPainter, type PluginUiEntry, type ViewerPanelProps } from '@rtgaia/sdk';

const ID = 'hello-threshold';
const VERSION = '0.1.1';
const MODE = `plugin:${ID}`;

function HelloPanel({ api }: ViewerPanelProps): React.JSX.Element {
  const [painting, setPainting] = useState(false);
  useEffect(() => {
    if (!painting) return;
    const painter: OverlayPainter = {
      id: `${ID}.cross`,
      viewportId: '*',
      order: 900,
      paint(ctx) {
        const p = ctx.project([0, 0, 0]);
        ctx.ctx.strokeStyle = 'rgba(255, 200, 0, 0.9)';
        ctx.ctx.lineWidth = 1;
        ctx.ctx.beginPath();
        ctx.ctx.moveTo(p.x - 8, p.y);
        ctx.ctx.lineTo(p.x + 8, p.y);
        ctx.ctx.moveTo(p.x, p.y - 8);
        ctx.ctx.lineTo(p.x, p.y + 8);
        ctx.ctx.stroke();
      },
    };
    const off = api.overlay.register(painter);
    api.commands.repaintOverlays();
    return () => {
      off();
      api.commands.repaintOverlays();
    };
  }, [painting, api.overlay, api.commands]);

  return (
    <section>
      <h3>Hello plugin</h3>
      <p>結構 {api.state.structures.length} 個；FoR {api.state.frameGroups.length} 個。</p>
      <label>
        <input type="checkbox" checked={painting} onChange={(e) => setPainting(e.target.checked)} /> 在原點畫十字
      </label>
    </section>
  );
}

const entry: PluginUiEntry = {
  id: ID,
  version: VERSION,
  sdkVersion: '^0.1.0',
  register() {
    registerModule({
      id: ID,
      version: VERSION,
      panels: [
        {
          id: `${ID}.panel`,
          slot: 'right-sidebar',
          order: 500,
          title: 'Hello',
          component: HelloPanel,
          visibleWhen: (s) => s.modes.includes(MODE),
        },
      ],
    });
  },
};

export default entry;
