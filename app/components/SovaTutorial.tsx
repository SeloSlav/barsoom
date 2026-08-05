"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  isSovaTutorialId,
  SOVA_TUTORIAL_EVENT,
  SOVA_TUTORIALS,
  type SovaTutorialId,
} from "../tutorials/sova";

const VOCALIZER_BARS = Array.from({ length: 14 }, (_, index) => index);

let activeNarration: HTMLAudioElement | null = null;

type TutorialSession = {
  id: SovaTutorialId;
  autoPlayDelayMs: number;
};

type SovaTutorialProps = {
  libraryVisible: boolean;
  onCloseLibrary: () => void;
};

function stopNarration(audio: HTMLAudioElement) {
  audio.pause();
  if (activeNarration === audio) activeNarration = null;
}

async function playNarrationExclusive(audio: HTMLAudioElement) {
  if (activeNarration && activeNarration !== audio) {
    activeNarration.pause();
    activeNarration.currentTime = 0;
  }

  activeNarration = audio;
  try {
    await audio.play();
  } catch (error) {
    if (activeNarration === audio) activeNarration = null;
    throw error;
  }
}

export function SovaTutorial({ libraryVisible, onCloseLibrary }: SovaTutorialProps) {
  const [currentSession, setCurrentSession] = useState<TutorialSession | null>({ id: "telescope", autoPlayDelayMs: 0 });
  const [skipFuture, setSkipFuture] = useState(false);
  const [seenIds, setSeenIds] = useState<ReadonlySet<SovaTutorialId>>(() => new Set(["telescope"]));
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const skipFutureRef = useRef(false);
  const seenRef = useRef(new Set<SovaTutorialId>(["telescope"]));

  const markSeen = useCallback((id: SovaTutorialId) => {
    if (seenRef.current.has(id)) return;
    seenRef.current.add(id);
    setSeenIds(new Set(seenRef.current));
  }, []);

  useEffect(() => {
    const handleTutorial = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (!isSovaTutorialId(id) || skipFutureRef.current || seenRef.current.has(id)) return;
      markSeen(id);
      setProgress(0);
      setPlaying(false);
      setPlaybackBlocked(false);
      setCurrentSession({ id, autoPlayDelayMs: SOVA_TUTORIALS[id].autoPlayDelayMs });
    };
    window.addEventListener(SOVA_TUTORIAL_EVENT, handleTutorial);
    return () => window.removeEventListener(SOVA_TUTORIAL_EVENT, handleTutorial);
  }, [markSeen]);

  useEffect(() => {
    if (!currentSession || libraryVisible) return;
    const tutorial = SOVA_TUTORIALS[currentSession.id];
    const audio = new Audio(tutorial.audioSrc);
    let cancelled = false;
    audio.preload = "auto";
    audio.volume = 0.82;
    audioRef.current = audio;

    const updateProgress = () => setProgress(audio.duration > 0 ? audio.currentTime / audio.duration : 0);
    const markPlaying = () => {
      setPlaying(true);
      setPlaybackBlocked(false);
      window.__BARSOOM__?.setNarrationActive(true);
    };
    const markPaused = () => {
      setPlaying(false);
      window.__BARSOOM__?.setNarrationActive(false);
    };
    const attemptPlayback = async () => {
      try {
        await playNarrationExclusive(audio);
        if (cancelled || audioRef.current !== audio) stopNarration(audio);
      } catch {
        if (!cancelled) setPlaybackBlocked(true);
      }
    };
    audio.addEventListener("timeupdate", updateProgress);
    audio.addEventListener("play", markPlaying);
    audio.addEventListener("pause", markPaused);
    audio.addEventListener("ended", markPaused);
    const autoPlayTimer = window.setTimeout(() => {
      void attemptPlayback();
    }, currentSession.autoPlayDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(autoPlayTimer);
      stopNarration(audio);
      audio.removeEventListener("timeupdate", updateProgress);
      audio.removeEventListener("play", markPlaying);
      audio.removeEventListener("pause", markPaused);
      audio.removeEventListener("ended", markPaused);
      if (audioRef.current === audio) audioRef.current = null;
      window.__BARSOOM__?.setNarrationActive(false);
    };
  }, [currentSession, libraryVisible]);

  const openTutorial = (id: SovaTutorialId) => {
    markSeen(id);
    setProgress(0);
    setPlaying(false);
    setPlaybackBlocked(false);
    setCurrentSession({ id, autoPlayDelayMs: 0 });
    onCloseLibrary();
  };

  const resetTutorials = () => {
    skipFutureRef.current = false;
    seenRef.current.clear();
    seenRef.current.add("telescope");
    setSkipFuture(false);
    setSeenIds(new Set(["telescope"]));
    setProgress(0);
    setPlaying(false);
    setPlaybackBlocked(false);
    setCurrentSession({ id: "telescope", autoPlayDelayMs: 0 });
    onCloseLibrary();
  };

  if (libraryVisible) {
    return (
      <aside id="sova-tutorial-library" className="tutorial-library" role="dialog" aria-modal="false" aria-labelledby="tutorial-library-title">
        <button className="tutorial-library-close" type="button" onClick={onCloseLibrary} aria-label="Close tutorial library">×</button>
        <p className="panel-index">SOVA ARCHIVE / MANUAL ACCESS</p>
        <p className="eyebrow">MISSION TUTORIALS</p>
        <h2 id="tutorial-library-title">Briefing library</h2>
        <p className="tutorial-library-intro">Replay any SOVA briefing independently, or reset the sequence so contextual tutorials can appear again.</p>
        <div className="tutorial-library-list">
          {Object.values(SOVA_TUTORIALS).map((tutorial) => {
            const seen = seenIds.has(tutorial.id);
            return <article className="tutorial-library-entry" key={tutorial.id}>
              <div>
                <span>{tutorial.sequence}</span>
                <h3>{tutorial.title}</h3>
                <small>{seen ? "HEARD THIS SESSION" : "READY FOR MANUAL PLAYBACK"}</small>
              </div>
              <button type="button" onClick={() => openTutorial(tutorial.id)}>{seen ? "REPLAY" : "LISTEN"}</button>
            </article>;
          })}
        </div>
        <div className="tutorial-library-reset">
          <div>
            <strong>RESET TUTORIAL SEQUENCE</strong>
            <span>Clears skipped and heard status, then starts Briefing 01.</span>
          </div>
          <button type="button" onClick={resetTutorials}>RESET &amp; RESTART</button>
        </div>
        <span className="sr-only" aria-live="polite">{seenIds.size} of {Object.keys(SOVA_TUTORIALS).length} tutorials heard this session.</span>
      </aside>
    );
  }

  if (!currentSession) return null;
  const tutorial = SOVA_TUTORIALS[currentSession.id];

  const closeTutorial = () => {
    audioRef.current?.pause();
    setProgress(0);
    setPlaying(false);
    setPlaybackBlocked(false);
    setCurrentSession(null);
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      stopNarration(audio);
      return;
    }
    if (audio.ended) audio.currentTime = 0;
    void playNarrationExclusive(audio).catch(() => setPlaybackBlocked(true));
  };

  const setSkipAll = (skip: boolean) => {
    skipFutureRef.current = skip;
    setSkipFuture(skip);
  };

  return (
    <aside className="sova-tutorial" role="dialog" aria-modal="false" aria-labelledby="sova-tutorial-title">
      <button className="sova-close" type="button" onClick={closeTutorial} aria-label="Close SOVA briefing">×</button>
      <figure className="sova-portrait">
        <Image src="/images/sova-profile.png" width="768" height="768" unoptimized alt="SOVA, the blue and violet holographic mission intelligence" />
        <figcaption><i aria-hidden="true" /> SOVA / ONLINE</figcaption>
        <div className={`sova-vocalizer${playing ? " speaking" : ""}`} aria-hidden="true">
          {VOCALIZER_BARS.map((bar) => <span key={bar} />)}
        </div>
      </figure>
      <div className="sova-briefing">
        <span className="sova-sequence">{tutorial.sequence}</span>
        <span className="sova-identity">SYNTHETIC OPERATIONS &amp; VANTAGE ADVISOR</span>
        <h2 id="sova-tutorial-title">{tutorial.title}</h2>
        <div className="sova-transcript">{tutorial.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
        <div className="sova-playback">
          <button type="button" onClick={togglePlayback}>{playing ? "PAUSE" : progress > 0.98 ? "REPLAY BRIEFING" : playbackBlocked ? "PLAY BRIEFING" : "RESUME BRIEFING"}</button>
          <div className="sova-progress" aria-hidden="true"><i style={{ width: `${Math.max(1.5, progress * 100)}%` }} /></div>
          <span>{playing ? "VOICE LINK ACTIVE" : playbackBlocked ? "GESTURE REQUIRED" : "VOICE LINK STANDBY"}</span>
        </div>
        <div className="sova-dismissal">
          <label><input type="checkbox" checked={skipFuture} onChange={(event) => setSkipAll(event.target.checked)} /> <span>Skip all future tutorials</span></label>
          <small>Session only · resets on refresh</small>
          <button type="button" onClick={closeTutorial}>DISMISS</button>
        </div>
      </div>
    </aside>
  );
}
