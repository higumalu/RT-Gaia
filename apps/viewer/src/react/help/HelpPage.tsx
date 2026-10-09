/** `#/help`：使用手冊頁 —— 說明段落 ＋ 快捷鍵表，同一份資料來源。 */
import { CORE_KEYS, mouseBindingRows, toolKeyBindings } from '../../core/keys';
import { GUIDE } from './guide';
import { t } from '../../core/i18n';

export function HelpPage(): React.JSX.Element {
  return (
    <div className="help-page">
      <header className="help-header">
        <h1>{t('RT-Gaia 使用手冊')}</h1>
        <nav>
          {GUIDE.map((g) => (
            <a key={g.id} href={`#/help#${g.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`help-${g.id}`)?.scrollIntoView({ behavior: 'smooth' }); }}>
              {t(g.title)}
            </a>
          ))}
          <a href="#/help#keys" onClick={(e) => { e.preventDefault(); document.getElementById('help-keys')?.scrollIntoView({ behavior: 'smooth' }); }}>{t('快捷鍵')}</a>
          <a className="button-link" href="#/viewer">{t('回檢視器')}</a>
        </nav>
      </header>
      <main>
        {GUIDE.map((g) => (
          <section key={g.id} id={`help-${g.id}`}>
            <h2>{t(g.title)}</h2>
            <ul>
              {g.lines.map((line, i) => (
                <li key={i}>{t(line)}</li>
              ))}
            </ul>
          </section>
        ))}
        <section id="help-keys">
          <h2>{t('快捷鍵')}</h2>
          <table className="shortcuts-table">
            <tbody>
              {[...toolKeyBindings(), ...CORE_KEYS].map((k) => (
                <tr key={k.id}>
                  <td><kbd>{t(k.keys)}</kbd></td>
                  <td>{t(k.label)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>{t('滑鼠（2D 格）')}</h2>
          <table className="shortcuts-table">
            <tbody>
              {mouseBindingRows().map((r) => (
                <tr key={r.gesture}>
                  <td><kbd>{r.gesture}</kbd></td>
                  <td>{r.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
