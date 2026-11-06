import { useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../shared/settings';
import type { ExtensionSettings } from '../shared/types';

type Tab = 'general' | 'translation' | 'appearance';
type LiveStatus = { status: 'idle' | 'starting' | 'recording' | 'error'; tabId?: number; error?: string };

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [tab, setTab] = useState<Tab>('general');
  const [live, setLive] = useState<LiveStatus>({ status: 'idle' });
  const [usage, setUsage] = useState<Record<string, number>>({});

  useEffect(() => {
    void getSettings().then(setSettings);
    void chrome.runtime.sendMessage({ type: 'GET_LIVE_TRANSCRIPTION_STATUS' }).then((status: LiveStatus) => setLive(status));
    void chrome.storage.local.get('sub3Usage').then(({ sub3Usage }) => setUsage(todayUsage(sub3Usage)));
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes.sub3LiveTranscription?.newValue) setLive(changes.sub3LiveTranscription.newValue as LiveStatus);
      if (area === 'local' && changes.sub3Usage) setUsage(todayUsage(changes.sub3Usage.newValue));
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  const toggleLiveTranscription = async (): Promise<void> => {
    if (live.status === 'recording' || live.status === 'starting') {
      setLive({ status: 'idle' });
      const response = await chrome.runtime.sendMessage({ type: 'STOP_LIVE_TRANSCRIPTION' }) as { ok?: boolean; error?: string };
      if (!response?.ok) setLive({ status: 'error', error: response?.error });
      return;
    }
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab.id) return setLive({ status: 'error', error: 'Активну вкладку не знайдено' });
    setLive({ status: 'starting', tabId: activeTab.id });
    const response = await chrome.runtime.sendMessage({ type: 'START_LIVE_TRANSCRIPTION', tabId: activeTab.id }) as { ok?: boolean; error?: string };
    if (!response?.ok) setLive({ status: 'error', tabId: activeTab.id, error: response?.error });
  };
  const update = async (values: Partial<ExtensionSettings>): Promise<void> => {
    if (!settings) return;
    setSettings((current) => current ? { ...current, ...values } : current);
    await updateSettings(values);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab.id) await chrome.tabs.sendMessage(tab.id, { type: 'SUB3_SETTINGS_UPDATED', changes: values });
    } catch {
      // Restricted pages do not have a content script; storage still keeps the setting.
    }
  };
  if (!settings) return <main className="popup loading">Завантаження…</main>;

  const quota = settings.translationProvider === 'gemini' || settings.translationProvider === 'groq' || settings.translationProvider === 'deepl';
  const providerName = { chrome: 'Chrome', libretranslate: 'LibreTranslate', deepl: 'DeepL', gemini: 'Gemini', groq: 'Groq' }[settings.translationProvider];
  const languages = <><option value="en">English</option><option value="uk">Українська</option><option value="ru">Русский</option><option value="de">Deutsch</option><option value="pl">Polski</option><option value="es">Español</option><option value="fr">Français</option></>;
  const recording = live.status === 'recording' || live.status === 'starting';

  return <main className={`popup ${settings.enabled ? '' : 'is-off'}`}>
    <header className="header">
      <img className="logo" src="/assets/sub3-logo.png" alt="Sub3" />
      <label className="switch" title={settings.enabled ? 'Вимкнути Sub3' : 'Увімкнути Sub3'}>
        <input type="checkbox" checked={settings.enabled} onChange={(event) => void update({ enabled: event.target.checked })} aria-label="Sub3 увімкнено" />
        <span />
      </label>
    </header>

    <nav className="tabs" role="tablist">
      <TabButton id="general" active={tab} setTab={setTab}>Субтитри</TabButton>
      <TabButton id="translation" active={tab} setTab={setTab}>Переклад</TabButton>
      <TabButton id="appearance" active={tab} setTab={setTab}>Вигляд</TabButton>
    </nav>

    <section className="content">
      {tab === 'general' && <>
        <div className="group">
          <Row label="Мова субтитрів"><select id="source-language" value={settings.sourceLanguage} onChange={(event) => void update({ sourceLanguage: event.target.value })}>{languages}</select></Row>
          <Row label="Перекладати на"><select id="target-language" value={settings.targetLanguage} onChange={(event) => void update({ targetLanguage: event.target.value })}>{languages}</select></Row>
        </div>
        <div className="group">
          <Toggle id="show-original" label="Оригінал" checked={settings.originalVisible} onChange={(originalVisible) => void update({ originalVisible })} />
          <Toggle id="show-translation" label="Переклад" checked={settings.translationVisible} onChange={(translationVisible) => void update({ translationVisible })} />
        </div>
        <p className="hint">Наведіть на слово, щоб побачити переклад. Клік по слову — пояснення{quota ? ` від ${providerName}` : ''} і переклад усієї фрази.</p>

        <h2>Відео без субтитрів</h2>
        <div className="group">
          <Row label="Розпізнавання"><select id="speech-provider" value={settings.speechRecognitionProvider} onChange={(event) => void update({ speechRecognitionProvider: event.target.value as ExtensionSettings['speechRecognitionProvider'] })}><option value="groq">Groq</option><option value="mlx">MLX на цьому Mac</option></select></Row>
          <Row label="Мова мовлення"><select id="speech-language" value={settings.speechRecognitionLanguage} onChange={(event) => void update({ speechRecognitionLanguage: event.target.value })}><option value="auto">Визначити</option>{languages}</select></Row>
        </div>
        <button className={`live ${recording ? 'is-on' : ''}`} type="button" disabled={live.status === 'starting'} onClick={() => void toggleLiveTranscription()}>
          <span className="dot" aria-hidden="true" />
          {live.status === 'recording' ? 'Зупинити' : live.status === 'starting' ? 'Підключаюсь до звуку…' : 'Розпізнавати мовлення'}
        </button>
        <p className={`hint ${live.error ? 'error' : ''}`}>{live.error || (settings.speechRecognitionProvider === 'mlx' ? 'Спершу запустіть MLX-сервер (npm run mlx-whisper).' : 'Потрібен ключ Groq. Перший текст з’явиться через 10–12 с.')}</p>
      </>}

      {tab === 'translation' && <>
        <div className="group">
          <Row label="Перекладач"><select id="provider" value={settings.translationProvider} onChange={(event) => void update({ translationProvider: event.target.value as ExtensionSettings['translationProvider'] })}><option value="chrome">Chrome</option><option value="deepl">DeepL</option><option value="gemini">Gemini</option><option value="groq">Groq</option><option value="libretranslate">LibreTranslate</option></select></Row>
          {settings.translationProvider === 'libretranslate' && <Field id="libre-endpoint" label="Адреса сервера"><input id="libre-endpoint" value={settings.translationEndpoint} onChange={(event) => void update({ translationEndpoint: event.target.value })} /></Field>}
          {settings.translationProvider === 'deepl' && <Field id="deepl-key" label="Ключ DeepL"><input id="deepl-key" type="password" value={settings.deeplApiKey} onChange={(event) => void update({ deeplApiKey: event.target.value })} placeholder="…:fx" autoComplete="off" /></Field>}
          {settings.translationProvider === 'gemini' && <>
            <Field id="gemini-key" label="Ключ Gemini"><input id="gemini-key" type="password" value={settings.geminiApiKey} onChange={(event) => void update({ geminiApiKey: event.target.value })} placeholder="AIza…" autoComplete="off" /></Field>
            <Field id="gemini-model" label="Модель"><input id="gemini-model" value={settings.geminiModel} onChange={(event) => void update({ geminiModel: event.target.value })} /></Field>
          </>}
          {settings.translationProvider === 'groq' && <>
            <Field id="groq-key" label="Ключ Groq"><input id="groq-key" type="password" value={settings.groqApiKey} onChange={(event) => void update({ groqApiKey: event.target.value })} placeholder="gsk_…" autoComplete="off" /></Field>
            <Field id="groq-model" label="Модель"><input id="groq-model" value={settings.groqModel} onChange={(event) => void update({ groqModel: event.target.value })} /></Field>
          </>}
        </div>
        <p className="hint">{settings.translationProvider === 'chrome'
          ? 'Перекладає сам Chrome, без ключа й лімітів. Мовний пакет завантажиться під час першого перекладу.'
          : settings.translationProvider === 'libretranslate'
            ? 'Локальний сервер: npm run translator.'
            : `Рядок під субтитрами перекладає Chrome. ${providerName} працює лише, коли ви клікаєте на слово. Ключ зберігається тільки в цьому браузері.`}</p>
        <p className="hint">На YouTube рядок перекладу береться з автоперекладу YouTube, а якщо ввімкнено «Готові субтитри» — з субтитрів, зроблених людиною. Chrome перекладає лише те, чого там немає.</p>
        {quota && <p className="usage">Запитів сьогодні <b>{usage[settings.translationProvider] ?? 0}</b></p>}

        <div className="group">
          <Toggle id="preload" label="Перекладати весь фільм заздалегідь" checked={settings.preloadSubtitleTrack} onChange={(preloadSubtitleTrack) => void update({ preloadSubtitleTrack })} />
          <Toggle id="youtube-human" label="Готові субтитри YouTube, якщо є" checked={settings.youtubeHumanSubtitles} onChange={(youtubeHumanSubtitles) => void update({ youtubeHumanSubtitles })} />
          {settings.translationProvider !== 'groq' && settings.translationProvider !== 'chrome' && <Toggle id="fallback" label="При вичерпаному ліміті — Groq" checked={settings.groqFallbackEnabled} onChange={(groqFallbackEnabled) => void update({ groqFallbackEnabled })} />}
          {settings.groqFallbackEnabled && settings.translationProvider !== 'groq' && settings.translationProvider !== 'chrome' && <Field id="fallback-key" label="Ключ Groq"><input id="fallback-key" type="password" value={settings.groqApiKey} onChange={(event) => void update({ groqApiKey: event.target.value })} placeholder="gsk_…" autoComplete="off" /></Field>}
        </div>

        {settings.speechRecognitionProvider === 'mlx' && <>
          <h2>MLX Whisper</h2>
          <div className="group">
            <Row label="Модель"><select id="mlx-model" value={settings.mlxWhisperModel} onChange={(event) => void update({ mlxWhisperModel: event.target.value })}><option value="mlx-community/whisper-small-mlx">Small, ~2,5 с</option><option value="mlx-community/whisper-tiny">Tiny, ~1,5 с</option></select></Row>
            <Field id="mlx-endpoint" label="Адреса сервера"><input id="mlx-endpoint" value={settings.mlxWhisperEndpoint} onChange={(event) => void update({ mlxWhisperEndpoint: event.target.value })} /></Field>
          </div>
        </>}
      </>}

      {tab === 'appearance' && <>
        <div className="preview" style={{ textAlign: settings.subtitleTextAlign }}>
          <span style={{ color: settings.textColor, fontWeight: settings.fontWeight === 'bold' ? 700 : 500, letterSpacing: `${settings.letterSpacing}px`, background: `rgb(0 0 0 / ${settings.subtitleBackgroundOpacity})` }}>But I think that’s all about to change.</span>
          <span style={{ color: settings.textColor, fontWeight: settings.fontWeight === 'bold' ? 700 : 500, letterSpacing: `${settings.letterSpacing}px`, background: `rgb(0 0 0 / ${settings.subtitleBackgroundOpacity})` }}>Але, гадаю, це от-от зміниться.</span>
        </div>
        <div className="group">
          <Slider id="font-size" label="Розмір" value={settings.fontSize} display={`${settings.fontSize} px`} min={14} max={42} step={1} onChange={(fontSize) => void update({ fontSize })} />
          <Slider id="bottom" label="Висота від низу" value={settings.subtitleBottomPercent} display={`${settings.subtitleBottomPercent}%`} min={3} max={70} step={1} onChange={(subtitleBottomPercent) => void update({ subtitleBottomPercent })} />
          <Slider id="horizontal" label="Зсув по горизонталі" value={settings.subtitleHorizontalPercent} display={`${settings.subtitleHorizontalPercent}%`} min={10} max={90} step={1} onChange={(subtitleHorizontalPercent) => void update({ subtitleHorizontalPercent })} />
          <Slider id="width" label="Ширина" value={settings.subtitleMaxWidthPercent} display={`${settings.subtitleMaxWidthPercent}%`} min={50} max={96} step={2} onChange={(subtitleMaxWidthPercent) => void update({ subtitleMaxWidthPercent })} />
          <Slider id="background" label="Фон" value={settings.subtitleBackgroundOpacity} display={`${Math.round(settings.subtitleBackgroundOpacity * 100)}%`} min={0} max={0.9} step={0.05} onChange={(subtitleBackgroundOpacity) => void update({ subtitleBackgroundOpacity })} />
          <Slider id="spacing" label="Інтервал між літерами" value={settings.letterSpacing} display={`${settings.letterSpacing} px`} min={-1} max={5} step={0.5} onChange={(letterSpacing) => void update({ letterSpacing })} />
        </div>
        <div className="group">
          <Row label="Вирівнювання"><div className="segmented">{(['left', 'center', 'right'] as const).map((alignment) => <button type="button" key={alignment} className={settings.subtitleTextAlign === alignment ? 'active' : ''} onClick={() => void update({ subtitleTextAlign: alignment })}>{alignment === 'left' ? 'Ліворуч' : alignment === 'right' ? 'Праворуч' : 'Центр'}</button>)}</div></Row>
          <Row label="Колір"><input id="text-color" className="color" type="color" value={settings.textColor} onChange={(event) => void update({ textColor: event.target.value })} /></Row>
          <Toggle id="bold" label="Жирний" checked={settings.fontWeight === 'bold'} onChange={(bold) => void update({ fontWeight: bold ? 'bold' : 'normal' })} />
        </div>
      </>}
    </section>
  </main>;
}

function todayUsage(value: unknown): Record<string, number> {
  const usage = value as { date?: string; counts?: Record<string, number> } | undefined;
  return usage?.date === new Date().toISOString().slice(0, 10) && usage.counts ? usage.counts : {};
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="row"><span className="label">{label}</span>{children}</div>;
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className="field"><label className="label" htmlFor={id}>{label}</label>{children}</div>;
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="row toggle" htmlFor={id}>
    <span className="label">{label}</span>
    <span className="switch small"><input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span /></span>
  </label>;
}

function Slider({ id, label, value, display, min, max, step, onChange }: { id: string; label: string; value: number; display: string; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <div className="slider">
    <label className="label" htmlFor={id}>{label}<output>{display}</output></label>
    <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
  </div>;
}

function TabButton({ id, active, setTab, children }: { id: Tab; active: Tab; setTab: (tab: Tab) => void; children: string }) {
  return <button type="button" role="tab" aria-selected={active === id} className={active === id ? 'active' : ''} onClick={() => setTab(id)}>{children}</button>;
}
