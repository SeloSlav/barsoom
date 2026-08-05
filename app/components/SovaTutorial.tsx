"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  isSovaTutorialId,
  SOVA_TUTORIAL_EVENT,
  SOVA_TUTORIALS,
  type SovaTutorialId,
} from "../tutorials/sova";

const VOCALIZER_BARS = Array.from({ length: 14 }, (_, index) => index);

export function SovaTutorial() {
  const [currentId, setCurrentId] = useState<SovaTutorialId | null>("telescope");
  const [skipFuture, setSkipFuture] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentRef = useRef<SovaTutorialId | null>("telescope");
  const skipFutureRef = useRef(false);
  const queueRef = useRef<SovaTutorialId[]>([]);
  const seenRef = useRef(new Set<SovaTutorialId>(["telescope"]));

  useEffect(() => {
    const handleTutorial = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (!isSovaTutorialId(id) || skipFutureRef.current || seenRef.current.has(id)) return;
      seenRef.current.add(id);
      if (currentRef.current) {
        queueRef.current.push(id);
      } else {
        currentRef.current = id;
        setProgress(0);
        setPlaying(false);
        setPlaybackBlocked(false);
        setCurrentId(id);
      }
    };
    window.addEventListener(SOVA_TUTORIAL_EVENT, handleTutorial);
    return () => window.removeEventListener(SOVA_TUTORIAL_EVENT, handleTutorial);
  }, []);

  useEffect(() => {
    if (!currentId) return;
    const audio = new Audio(SOVA_TUTORIALS[currentId].audioSrc);
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
    audio.addEventListener("timeupdate", updateProgress);
    audio.addEventListener("play", markPlaying);
    audio.addEventListener("pause", markPaused);
    audio.addEventListener("ended", markPaused);
    void audio.play().catch(() => setPlaybackBlocked(true));

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", updateProgress);
      audio.removeEventListener("play", markPlaying);
      audio.removeEventListener("pause", markPaused);
      audio.removeEventListener("ended", markPaused);
      if (audioRef.current === audio) audioRef.current = null;
      window.__BARSOOM__?.setNarrationActive(false);
    };
  }, [currentId]);

  if (!currentId) return null;
  const tutorial = SOVA_TUTORIALS[currentId];

  const closeTutorial = () => {
    audioRef.current?.pause();
    const next = skipFutureRef.current ? null : queueRef.current.shift() ?? null;
    if (skipFutureRef.current) queueRef.current = [];
    currentRef.current = next;
    setProgress(0);
    setPlaying(false);
    setPlaybackBlocked(false);
    setCurrentId(next);
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (audio.ended) audio.currentTime = 0;
    void audio.play().catch(() => setPlaybackBlocked(true));
  };

  const setSkipAll = (skip: boolean) => {
    skipFutureRef.current = skip;
    setSkipFuture(skip);
    if (skip) queueRef.current = [];
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
