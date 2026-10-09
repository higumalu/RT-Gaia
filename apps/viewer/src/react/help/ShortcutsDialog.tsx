/** 快捷鍵與滑鼠操作表 —— 內容全部從 `core/keys.ts` 產生。 */
import { CORE_KEYS, mouseBindingRows, toolKeyBindings, type KeyScope } from '../../core/keys';
import { Dialog } from '../components/Dialog';
import { msg, t } from '../../core/i18n';

const SCOPE_LABEL: Record<KeyScope, string> = { global: msg('任何時候'), viewport: msg('影像格'), sidebar: msg('側欄'), menu: msg('選單'), dialog: msg('對話框') };

export function ShortcutsDialog(props: { onClose: () => void; onStartTour: () => void }): React.JSX.Element {
  const keys = [...toolKeyBindings(), ...CORE_KEYS];
  const scopes = [...new Set(keys.map((k) => k.scope))];
  return (
    <Dialog label={t('快捷鍵與滑鼠操作')} className="shortcuts-dialog" onClose={props.onClose}>
      <h3>{t('快捷鍵與滑鼠操作')}</h3>
      <div className="shortcuts-columns">
        <section>
          <h4>{t('鍵盤')}</h4>
          {scopes.map((scope) => (
            <table key={scope} className="shortcuts-table">
              <caption>{SCOPE_LABEL[scope]}</caption>
              <tbody>
                {keys
                  .filter((k) => k.scope === scope)
                  .map((k) => (
                    <tr key={k.id}>
                      <td>
                        <kbd>{t(k.keys)}</kbd>
                      </td>
                      <td>{t(k.label)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ))}
        </section>
        <section>
          <h4>{t('滑鼠（2D 格）')}</h4>
          <table className="shortcuts-table">
            <tbody>
              {mouseBindingRows().map((r) => (
                <tr key={r.gesture}>
                  <td>
                    <kbd>{r.gesture}</kbd>
                  </td>
                  <td>{r.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={props.onStartTour}>
          {t('功能導覽')}
        </button>
        <a className="button-link" href="#/help">
          {t('使用手冊')}
        </a>
        <button type="button" className="primary" onClick={props.onClose} data-autofocus>
          {t('關閉')}
        </button>
      </div>
    </Dialog>
  );
}
