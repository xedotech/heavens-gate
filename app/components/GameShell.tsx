'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Car,
  Check,
  Code2,
  Eye,
  Gamepad2,
  Gauge,
  Headphones,
  Heart,
  Keyboard,
  Map as MapIcon,
  Play,
  Radio,
  RotateCcw,
  Settings,
  Shield,
  Skull,
  Sparkles,
  Target,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import type { HeavensGateEngine } from '../game/engine';
import { formatDistance } from '../game/mechanics';
import {
  DEFAULT_SETTINGS,
  INITIAL_HUD,
  MISSIONS,
  type CharacterSkin,
  type Difficulty,
  type GameSettings,
  type HUDState,
  type InteractionPrompt,
  type MapSnapshot,
  type Quality,
  type SaveState,
  type ScreenState,
  type SubtitleLine,
  type ToastMessage,
} from '../game/types';

const SAVE_KEY = 'heavens-gate-save-v1';
const SETTINGS_KEY = 'heavens-gate-settings-v1';
const CHARACTER_SKINS: Array<{ id: CharacterSkin; name: string; detail: string }> = [
  { id: 'seraph', name: 'Seraph', detail: 'Gilded canon' },
  { id: 'relic', name: 'Relic', detail: 'Sun-worn bronze' },
  { id: 'nocturne', name: 'Nocturne', detail: 'Midnight tactical' },
  { id: 'ash', name: 'Ash', detail: 'Ruin survivor' },
  { id: 'meridian', name: 'Meridian', detail: 'Verdant sentinel' },
  { id: 'voidborn', name: 'Voidborn', detail: 'Veil-touched' },
];

function loadJSON<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function MiniMap({ snapshot, label }: { snapshot: MapSnapshot; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const size = 164;
    const ratio = Math.min(window.devicePixelRatio, 2);
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, size, size);

    const center = size / 2;
    context.fillStyle = 'rgba(8, 12, 14, 0.9)';
    context.beginPath();
    context.arc(center, center, center - 2, 0, Math.PI * 2);
    context.fill();
    context.save();
    context.beginPath();
    context.arc(center, center, center - 5, 0, Math.PI * 2);
    context.clip();

    context.strokeStyle = 'rgba(214, 192, 127, 0.14)';
    context.lineWidth = 1;
    for (let line = -150; line <= 150; line += 30) {
      const pixel = ((line + snapshot.worldSize / 2) / snapshot.worldSize) * size;
      context.beginPath();
      context.moveTo(0, pixel);
      context.lineTo(size, pixel);
      context.stroke();
      context.beginPath();
      context.moveTo(pixel, 0);
      context.lineTo(pixel, size);
      context.stroke();
    }

    const colors: Record<MapSnapshot['points'][number]['kind'], string> = {
      player: '#f2d377',
      objective: '#fff3c4',
      hostile: '#e4644d',
      civilian: '#8fa6a7',
      vehicle: '#7fb9c1',
      gate: '#c49b42',
    };
    snapshot.points.forEach((point) => {
      const x = ((point.x + snapshot.worldSize / 2) / snapshot.worldSize) * size;
      const y = ((point.z + snapshot.worldSize / 2) / snapshot.worldSize) * size;
      context.save();
      context.translate(x, y);
      context.fillStyle = colors[point.kind];
      context.strokeStyle = colors[point.kind];
      if (point.kind === 'player') {
        context.rotate(-(point.rotation ?? 0));
        context.beginPath();
        context.moveTo(0, -7);
        context.lineTo(5, 6);
        context.lineTo(0, 3);
        context.lineTo(-5, 6);
        context.closePath();
        context.fill();
      } else if (point.kind === 'objective') {
        context.rotate(Math.PI / 4);
        context.fillRect(-4, -4, 8, 8);
      } else if (point.kind === 'gate') {
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(0, 0, 4.5, 0, Math.PI * 2);
        context.stroke();
      } else {
        context.beginPath();
        context.arc(0, 0, point.kind === 'hostile' ? 2.8 : 1.8, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    });
    context.restore();
    context.strokeStyle = 'rgba(232, 201, 111, 0.55)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(center, center, center - 2.5, 0, Math.PI * 2);
    context.stroke();
  }, [snapshot]);

  return <canvas ref={ref} className="mini-map" role="img" aria-label={`Tactical map of ${label}`} />;
}

function MenuButton({
  icon,
  title,
  detail,
  onClick,
  disabled = false,
  primary = false,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`menu-button${primary ? ' menu-button-primary' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="menu-button-icon" aria-hidden="true">{icon}</span>
      <span className="menu-button-copy"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
      <span className="menu-button-arrow" aria-hidden="true">↗</span>
    </button>
  );
}

export default function GameShell() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<HeavensGateEngine | null>(null);
  const subtitleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [screen, setScreen] = useState<ScreenState>('loading');
  const [returnScreen, setReturnScreen] = useState<'title' | 'paused'>('title');
  const [loading, setLoading] = useState({ progress: 0, label: 'Opening the sky' });
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [save, setSave] = useState<SaveState | null>(null);
  const [hud, setHUD] = useState<HUDState>(INITIAL_HUD);
  const [map, setMap] = useState<MapSnapshot>({ points: [], worldSize: 340 });
  const [subtitle, setSubtitle] = useState<SubtitleLine | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [interaction, setInteraction] = useState<InteractionPrompt | null>(null);
  const [muted, setMuted] = useState(false);
  const [tutorial, setTutorial] = useState(false);
  const [ending, setEnding] = useState<'open' | 'seal' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const storedSettings = loadJSON<Partial<GameSettings>>(SETTINGS_KEY);
    const mergedSettings: GameSettings = { ...DEFAULT_SETTINGS, ...storedSettings };
    const storedSave = loadJSON<SaveState>(SAVE_KEY);
    const storageSyncTimer = setTimeout(() => {
      if (storedSave?.version === 1) setSave(storedSave);
      setSettings(mergedSettings);
    }, 0);
    const toastTimers = toastTimersRef.current;

    const addToast = (toast: ToastMessage) => {
      setToasts((current) => [...current.slice(-2), toast]);
      const timer = setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== toast.id));
        toastTimersRef.current.delete(timer);
      }, 4600);
      toastTimers.add(timer);
    };

    let disposed = false;
    let engine: HeavensGateEngine | null = null;
    const bootEngine = async () => {
      try {
        const { HeavensGateEngine: Engine } = await import('../game/engine');
        if (disposed) return;
        engine = new Engine(canvas, {
        onReady: () => setScreen('title'),
        onLoadProgress: (progress, label) => setLoading({ progress, label }),
        onHUD: (nextHUD, nextMap) => {
          setHUD(nextHUD);
          setMap(nextMap);
        },
        onSubtitle: (line) => {
          if (subtitleTimerRef.current) clearTimeout(subtitleTimerRef.current);
          setSubtitle(line);
          subtitleTimerRef.current = setTimeout(() => setSubtitle(null), line.duration ?? 3600);
        },
        onToast: addToast,
        onInteraction: setInteraction,
        onPauseRequested: () => {
          engineRef.current?.pause();
          setScreen('paused');
        },
        onGameOver: () => {
          engineRef.current?.pause();
          setScreen('gameover');
        },
        onChoiceRequested: () => setScreen('choice'),
        onCampaignComplete: (choice) => {
          setEnding(choice);
          setScreen('ending');
        },
        onError: (message) => {
          setError(message);
          setScreen('title');
        },
        onSave: (nextSave) => {
          window.localStorage.setItem(SAVE_KEY, JSON.stringify(nextSave));
          setSave(nextSave);
        },
        }, mergedSettings);
        if (disposed) {
          engine.dispose();
          engine = null;
          return;
        }
        engineRef.current = engine;
        await engine.initialize();
      } catch (initializationError) {
        if (disposed) return;
        setError(initializationError instanceof Error ? initializationError.message : 'The world could not start.');
        setScreen('title');
      }
    };
    void bootEngine();

    return () => {
      disposed = true;
      if (subtitleTimerRef.current) clearTimeout(subtitleTimerRef.current);
      clearTimeout(storageSyncTimer);
      toastTimers.forEach((timer) => clearTimeout(timer));
      toastTimers.clear();
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (screen === 'settings' || screen === 'codex' || screen === 'credits') {
        setScreen(returnScreen);
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [returnScreen, screen]);

  const updateSettings = (patch: Partial<GameSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      engineRef.current?.setSettings(next);
      return next;
    });
  };

  const startGame = async (continueSave: boolean) => {
    if (error) return;
    setTutorial(true);
    setScreen('playing');
    await engineRef.current?.start(continueSave ? save : null);
    const timer = setTimeout(() => setTutorial(false), 8200);
    toastTimersRef.current.add(timer);
  };

  const resumeGame = async () => {
    setScreen('playing');
    await engineRef.current?.resume();
  };

  const openPanel = (panel: 'settings' | 'codex' | 'credits', from: 'title' | 'paused') => {
    setReturnScreen(from);
    setScreen(panel);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    engineRef.current?.setMuted(next);
  };

  const restartCampaign = () => {
    window.localStorage.removeItem(SAVE_KEY);
    setSave(null);
    void startGame(false);
  };

  const rootAttributes = {
    'data-high-contrast': settings.highContrast ? 'true' : 'false',
    'data-reduced-motion': settings.reducedMotion ? 'true' : 'false',
  };

  return (
    <main className="game-shell" {...rootAttributes}>
      <canvas ref={canvasRef} className="world-canvas" aria-label="The playable city of Aethel" />
      <div className="world-vignette" aria-hidden="true" />

      <header className="global-bar">
        <div className="brand-lockup" aria-label="Heaven's Gate">
          <span className="brand-sigil" aria-hidden="true">HG</span>
          <span><strong>Heaven&apos;s Gate</strong><small>Project Seraph // Open source</small></span>
        </div>
        <button className="icon-button" type="button" onClick={toggleMute} aria-label={muted ? 'Unmute game' : 'Mute game'}>
          {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
        </button>
      </header>

      {screen === 'loading' && (
        <section className="loading-screen" role="status" aria-live="polite">
          <div className="loading-glyph" aria-hidden="true"><span /><span /><span /></div>
          <p className="eyebrow">Constructing a living city</p>
          <h1>Heaven waits<br />for no machine.</h1>
          <div className="loading-track"><span style={{ width: `${loading.progress * 100}%` }} /></div>
          <div className="loading-meta"><span>{loading.label}</span><span>{Math.round(loading.progress * 100)}%</span></div>
        </section>
      )}

      {screen === 'title' && (
        <section className="title-screen" aria-labelledby="game-title">
          <div className="title-copy">
            <p className="eyebrow">A complete original campaign prototype</p>
            <h1 id="game-title"><span>Heaven&apos;s</span><span>Gate</span></h1>
            <p className="title-promise">A city beneath a fractured afterlife. Memory is currency. Every gate changes the rules.</p>
          </div>
          <nav className="title-menu" aria-label="Main menu">
            {save && (
              <MenuButton
                icon={<Play />}
                title="Continue"
                detail={`${MISSIONS[save.missionIndex]?.title ?? 'Afterlight'} · ${new Date(save.updatedAt).toLocaleDateString()}`}
                onClick={() => void startGame(true)}
                primary
              />
            )}
            <MenuButton icon={<Sparkles />} title={save ? 'New campaign' : 'Begin campaign'} detail="Start at The Bell Below" onClick={() => void startGame(false)} primary={!save} />
            <MenuButton icon={<Settings />} title="Settings" detail="Graphics, audio, accessibility" onClick={() => openPanel('settings', 'title')} />
            <MenuButton icon={<BookOpen />} title="Field manual" detail="Controls, systems, world" onClick={() => openPanel('codex', 'title')} />
            <MenuButton icon={<Code2 />} title="Open-source credits" detail="Original code, art direction, and license" onClick={() => openPanel('credits', 'title')} />
          </nav>
          <div className="title-support" aria-label="Platform support">
            <span><Keyboard aria-hidden="true" /> Keyboard + mouse</span>
            <span><Gamepad2 aria-hidden="true" /> Xbox / DualSense layout</span>
            <span><Headphones aria-hidden="true" /> Procedural spatial mix</span>
          </div>
        </section>
      )}

      {screen === 'playing' && (
        <section className="hud" aria-label="Game HUD">
          <div className="mission-panel">
            <p className="eyebrow">Active operation</p>
            <div className="mission-title-line"><h2>{hud.objectiveTitle}</h2>{hud.objectiveDistance !== null && <span>{formatDistance(hud.objectiveDistance)}</span>}</div>
            <p>{hud.objectiveText}</p>
            <div className="objective-track" aria-label={`${Math.round(hud.objectiveProgress * 100)} percent complete`}><span style={{ width: `${hud.objectiveProgress * 100}%` }} /></div>
          </div>

          <div className="world-status">
            <div><MapIcon aria-hidden="true" /><span><strong>{hud.district}</strong><small>Aethel // {hud.timeLabel}</small></span></div>
            <div className="heat-meter" aria-label={`Choir response tier ${hud.heatTier} of 5`}>
              <span>Choir</span>{Array.from({ length: 5 }).map((_, index) => <i key={index} className={index < hud.heatTier ? 'active' : ''} />)}
            </div>
          </div>

          <div className={`reticle${hud.reticleHit ? ' reticle-hit' : ''}`} aria-hidden="true"><span /><span /><span /><span /></div>

          <div className="vitals-panel">
            <MiniMap snapshot={map} label={hud.district} />
            <div className="vitals-bars">
              <div className="vital"><span><Heart aria-hidden="true" /> Vital</span><strong>{Math.round(hud.health)}</strong><i><b style={{ width: `${hud.health}%` }} /></i></div>
              <div className="vital armor"><span><Shield aria-hidden="true" /> Aegis</span><strong>{Math.round(hud.armor)}</strong><i><b style={{ width: `${hud.armor}%` }} /></i></div>
            </div>
          </div>

          <div className="combat-panel">
            {hud.inVehicle ? (
              <div className="speed-block"><span><Gauge aria-hidden="true" /> Seraph velocity</span><strong>{Math.round(hud.vehicleSpeed)}</strong><small>km/h</small></div>
            ) : (
              <div className="ammo-block"><span>Morrow / 9mm smart</span><strong>{hud.ammo.toString().padStart(2, '0')}</strong><small>/ {hud.reserveAmmo}</small></div>
            )}
            <div className="abilities">
              <div className={hud.veilActive ? 'active' : ''}><Eye aria-hidden="true" /><span><strong>Veil</strong><small>Q / LB</small></span><i>{hud.veilActive ? 'OPEN' : hud.veilCooldown > 0 ? `${Math.ceil(hud.veilCooldown)}s` : 'READY'}</i></div>
              <div><Zap aria-hidden="true" /><span><strong>Pulse</strong><small>F / RB</small></span><i>{hud.pulseCooldown > 0 ? `${Math.ceil(hud.pulseCooldown)}s` : 'READY'}</i></div>
            </div>
            <div className="resonance-track"><span style={{ width: `${hud.resonance}%` }} /><small>{Math.round(hud.resonance)} resonance</small></div>
          </div>

          {hud.bossHealth !== null && (
            <div className="boss-bar"><div><span>FALSE ARCHON</span><small>Machine Saint // Crown Basilica</small></div><i><b style={{ width: `${hud.bossHealth * 100}%` }} /></i></div>
          )}

          {interaction && <div className="interaction-prompt"><kbd>{interaction.action}</kbd><span>{interaction.label}</span></div>}
          {tutorial && (
            <div className="tutorial-strip" role="status">
              <span><kbd>WASD</kbd> Move</span><span><kbd>Mouse</kbd> Aim</span><span><kbd>LMB</kbd> Fire</span><span><kbd>E</kbd> Interact</span><span><kbd>Q</kbd> Veil</span><span><kbd>F</kbd> Pulse</span>
              <button type="button" onClick={() => setTutorial(false)} aria-label="Dismiss controls"><Check aria-hidden="true" /></button>
            </div>
          )}
          <div className="damage-vignette" style={{ opacity: hud.damageFlash }} aria-hidden="true" />
        </section>
      )}

      {subtitle && screen === 'playing' && (
        <div className="subtitle" role="status" aria-live="polite"><strong>{subtitle.speaker}</strong><span>{subtitle.text}</span></div>
      )}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <article className={`toast toast-${toast.tone ?? 'info'}`} key={toast.id}><span aria-hidden="true" /><div><strong>{toast.title}</strong>{toast.detail && <p>{toast.detail}</p>}</div></article>
        ))}
      </div>

      {screen === 'paused' && (
        <section className="menu-screen pause-screen" aria-labelledby="pause-title">
          <div className="menu-heading"><p className="eyebrow">Simulation suspended</p><h1 id="pause-title">Pause</h1><p>{hud.district} · {hud.objectiveTitle}</p></div>
          <nav className="pause-menu" aria-label="Pause menu">
            <MenuButton icon={<Play />} title="Return to Aethel" detail="Resume from this moment" onClick={() => void resumeGame()} primary />
            <MenuButton icon={<Settings />} title="Settings" onClick={() => openPanel('settings', 'paused')} />
            <MenuButton icon={<BookOpen />} title="Field manual" onClick={() => openPanel('codex', 'paused')} />
            <MenuButton icon={<RotateCcw />} title="Restart checkpoint" detail={save ? MISSIONS[save.missionIndex]?.title : 'The Bell Below'} onClick={() => { engineRef.current?.retryCheckpoint(); setScreen('playing'); void engineRef.current?.resume(); }} />
            <MenuButton icon={<ArrowLeft />} title="Return to title" detail="Progress is saved automatically" onClick={() => { engineRef.current?.returnToTitle(); setScreen('title'); }} />
          </nav>
        </section>
      )}

      {screen === 'settings' && (
        <section className="menu-screen settings-screen" aria-labelledby="settings-title">
          <div className="panel-header"><button className="back-button" type="button" onClick={() => setScreen(returnScreen)}><ArrowLeft aria-hidden="true" /> Back</button><div><p className="eyebrow">System calibration</p><h1 id="settings-title">Settings</h1></div></div>
          <div className="settings-grid">
            <fieldset><legend>Graphics</legend><p>Choose the render budget. Resolution adapts if frame rate drops.</p><div className="segmented-control">
              {(['low', 'medium', 'high'] as Quality[]).map((quality) => <button type="button" key={quality} className={settings.quality === quality ? 'selected' : ''} onClick={() => updateSettings({ quality })}>{quality}<small>{quality === 'low' ? 'Performance' : quality === 'medium' ? 'Balanced' : 'Cinematic'}</small></button>)}
            </div></fieldset>
            <fieldset className="skin-fieldset"><legend>Aurel // Character skins</legend><p>Six original physically shaded looks update live in the world. Faces, hair, eyes, armor, and civilians use the expanded human rendering system.</p><div className="segmented-control skin-control">
              {CHARACTER_SKINS.map((skin) => <button type="button" key={skin.id} className={settings.characterSkin === skin.id ? 'selected' : ''} onClick={() => updateSettings({ characterSkin: skin.id })}><span className={`skin-swatch skin-${skin.id}`} aria-hidden="true" /><span>{skin.name}</span><small>{skin.detail}</small></button>)}
            </div></fieldset>
            <fieldset><legend>Difficulty</legend><p>Changes incoming damage. Mission structure stays identical.</p><div className="segmented-control">
              {(['story', 'normal', 'ascendant'] as Difficulty[]).map((difficulty) => <button type="button" key={difficulty} className={settings.difficulty === difficulty ? 'selected' : ''} onClick={() => updateSettings({ difficulty })}>{difficulty}<small>{difficulty === 'story' ? '0.62× damage' : difficulty === 'normal' ? 'Intended' : '1.45× damage'}</small></button>)}
            </div></fieldset>
            <fieldset><legend>Audio</legend><label htmlFor="master-volume">Master volume <output>{Math.round(settings.volume * 100)}%</output></label><input id="master-volume" type="range" min="0" max="1" step="0.01" value={settings.volume} onChange={(event) => updateSettings({ volume: Number(event.target.value) })} /><button className="secondary-button" type="button" onClick={() => engineRef.current?.testAudio()}><Headphones aria-hidden="true" /> Test procedural mix</button></fieldset>
            <fieldset><legend>Controls</legend><label htmlFor="look-sensitivity">Look sensitivity <output>{Math.round(settings.sensitivity * 100)}%</output></label><input id="look-sensitivity" type="range" min="0.2" max="1.4" step="0.05" value={settings.sensitivity} onChange={(event) => updateSettings({ sensitivity: Number(event.target.value) })} /></fieldset>
            <fieldset className="toggle-fieldset"><legend>Accessibility</legend>
              <label><span><strong>Subtitles</strong><small>All narrative dialogue and radio calls</small></span><input type="checkbox" checked={settings.subtitles} onChange={(event) => updateSettings({ subtitles: event.target.checked })} /></label>
              <label><span><strong>Reduced motion</strong><small>Static title camera and instant menu transitions</small></span><input type="checkbox" checked={settings.reducedMotion} onChange={(event) => updateSettings({ reducedMotion: event.target.checked })} /></label>
              <label><span><strong>High contrast HUD</strong><small>Stronger panels, borders, and objective signals</small></span><input type="checkbox" checked={settings.highContrast} onChange={(event) => updateSettings({ highContrast: event.target.checked })} /></label>
            </fieldset>
          </div>
        </section>
      )}

      {screen === 'codex' && (
        <section className="menu-screen codex-screen" aria-labelledby="codex-title">
          <div className="panel-header"><button className="back-button" type="button" onClick={() => setScreen(returnScreen)}><ArrowLeft aria-hidden="true" /> Back</button><div><p className="eyebrow">Field manual // Version 1.0</p><h1 id="codex-title">How to survive heaven</h1></div></div>
          <div className="codex-grid">
            <article><Keyboard aria-hidden="true" /><h2>On foot</h2><dl><div><dt>Move</dt><dd>WASD / left stick</dd></div><div><dt>Aim</dt><dd>Mouse / right stick</dd></div><div><dt>Fire</dt><dd>Left mouse / RT</dd></div><div><dt>Jump</dt><dd>Space / A</dd></div><div><dt>Reload</dt><dd>R / X</dd></div></dl></article>
            <article><Car aria-hidden="true" /><h2>Vehicles</h2><dl><div><dt>Enter / exit</dt><dd>E / Y</dd></div><div><dt>Accelerate</dt><dd>W / RT stick axis</dd></div><div><dt>Steer</dt><dd>A D / left stick</dd></div><div><dt>Handbrake</dt><dd>Space</dd></div><div><dt>Overdrive</dt><dd>Shift</dd></div></dl></article>
            <article><Eye aria-hidden="true" /><h2>The Veil</h2><p>Press Q or LB to cross into memory-space for eight seconds. Echoes become tangible and hostiles remain visible through fog. It costs resonance and then enters cooldown.</p></article>
            <article><Zap aria-hidden="true" /><h2>Resonance pulse</h2><p>Press F or RB to emit a close-range shockwave. It breaks drone armor, staggers Wardens, and deals heavy damage to clustered enemies.</p></article>
            <article><Radio aria-hidden="true" /><h2>Living response</h2><p>Violence raises Choir heat. Civilians flee, drones converge, and patrol accuracy increases. Heat fades when you break contact.</p></article>
            <article><Target aria-hidden="true" /><h2>Campaign</h2><p>Seven authored operations move from Crown District to Meridian and Old Spine, ending in a permanent world-state choice. Checkpoints save at every operation.</p></article>
          </div>
        </section>
      )}

      {screen === 'gameover' && (
        <section className="modal-screen gameover-screen" role="dialog" aria-modal="true" aria-labelledby="gameover-title">
          <Skull aria-hidden="true" /><p className="eyebrow">Signal lost</p><h1 id="gameover-title">Aurel is remembered.</h1><p>The city keeps the last checkpoint. Death is only a route with worse lighting.</p>
          <div><button className="primary-action" type="button" onClick={() => { engineRef.current?.retryCheckpoint(); setScreen('playing'); void engineRef.current?.resume(); }}><RotateCcw aria-hidden="true" /> Retry checkpoint</button><button className="secondary-button" type="button" onClick={() => { engineRef.current?.returnToTitle(); setScreen('title'); }}>Return to title</button></div>
        </section>
      )}

      {screen === 'choice' && (
        <section className="choice-screen" role="dialog" aria-modal="true" aria-labelledby="choice-title">
          <div className="choice-heading"><p className="eyebrow">Final verdict // Irreversible in this timeline</p><h1 id="choice-title">What is heaven for?</h1><p>The Archon is silent. Aethel waits for the first honest answer in a century.</p></div>
          <div className="choice-grid">
            <button type="button" onClick={() => engineRef.current?.resolveEnding('open')}><Sparkles aria-hidden="true" /><span><small>Open the gates</small><strong>Return every stored soul.</strong><p>The dead come home. The living city changes forever.</p></span></button>
            <button type="button" onClick={() => engineRef.current?.resolveEnding('seal')}><Shield aria-hidden="true" /><span><small>Seal the gates</small><strong>Protect the living city.</strong><p>Aethel survives. Heaven remains a beautiful prison.</p></span></button>
          </div>
        </section>
      )}

      {screen === 'ending' && ending && (
        <section className={`ending-screen ending-${ending}`} aria-labelledby="ending-title">
          <p className="eyebrow">Campaign complete // {ending === 'open' ? 'The Returning' : 'The Quiet Sky'}</p>
          <h1 id="ending-title">{ending === 'open' ? 'The sky learned every name.' : 'The city chose tomorrow.'}</h1>
          <p>{ending === 'open' ? 'Across Aethel, locked rooms filled with voices people had spent lifetimes refusing to forget. The gates were no longer borders. They were reunions.' : 'The rings went dark one by one. Aethel woke beneath an ordinary dawn—safe, guilty, alive. Somewhere beyond the seal, heaven waited without an owner.'}</p>
          <blockquote>“Every city is a gate. Every choice is a key.” <cite>— Nia Vale</cite></blockquote>
          <div><button className="primary-action" type="button" onClick={() => { setScreen('playing'); void engineRef.current?.enterFreeRoam(); }}><MapIcon aria-hidden="true" /> Enter free roam</button><button className="secondary-button" type="button" onClick={() => openPanel('credits', 'title')}><Code2 aria-hidden="true" /> View credits</button></div>
        </section>
      )}

      {screen === 'credits' && (
        <section className="menu-screen credits-screen" aria-labelledby="credits-title">
          <div className="panel-header"><button className="back-button" type="button" onClick={() => setScreen(returnScreen)}><ArrowLeft aria-hidden="true" /> Back</button><div><p className="eyebrow">Open-source release</p><h1 id="credits-title">Built in the open</h1></div></div>
          <div className="credits-layout">
            <div className="credits-statement"><p>Heaven&apos;s Gate is an original browser-game vertical slice made from procedural geometry, authored systems, and synthesized sound. No GTA, Call of Duty, Free Guy, Rockstar, or other franchise assets are included.</p><p>The code is released under the MIT License so you can study it, fork it, replace the procedural art, and turn the prototype into a larger production.</p></div>
            <dl><div><dt>Creative direction</dt><dd>Celestial noir / Aurelian Void</dd></div><div><dt>World</dt><dd>Aethel · 340-meter systemic city</dd></div><div><dt>Campaign</dt><dd>8 operations · 2 endings · free roam</dd></div><div><dt>Graphics</dt><dd>Three.js · procedural geometry · ACES tone mapping</dd></div><div><dt>Sound</dt><dd>Web Audio synthesis · zero sampled tracks</dd></div><div><dt>Input</dt><dd>Keyboard, mouse, standard gamepad API</dd></div><div><dt>License</dt><dd>MIT</dd></div></dl>
            <button className="danger-button" type="button" onClick={restartCampaign}><RotateCcw aria-hidden="true" /> Erase save and begin again</button>
          </div>
        </section>
      )}

      {error && screen === 'title' && (
        <div className="error-banner" role="alert"><strong>The gate did not open.</strong><span>{error}</span><button type="button" onClick={() => window.location.reload()}>Retry</button></div>
      )}

      <div className="desktop-required" role="alert"><Gamepad2 aria-hidden="true" /><h1>A larger gate is required.</h1><p>Heaven&apos;s Gate is built for PC, Mac, and console-sized displays. Use a window at least 900 × 600.</p></div>
    </main>
  );
}
