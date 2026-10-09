const iconUrl = `${import.meta.env.BASE_URL}branding/rt-gaia-icon-64.png`; // 畫面上 32 px（2× 螢幕 64 px）；原圖 1254 px、0.84 MB，慢網路上開頁就為它多等好幾秒

/** 共用品牌標題；圖示旁已有產品名稱，避免螢幕閱讀器重複朗讀。 */
export function Brand({ section }: { section?: string }): React.JSX.Element {
  return (
    <h1 className="brand">
      <img className="brand-icon" src={iconUrl} alt="" width={32} height={32} />
      <span>RT-Gaia{section ? ` · ${section}` : ''}</span>
    </h1>
  );
}
