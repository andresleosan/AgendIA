"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type AnimationEvent } from "react";
import { BrandCredits } from "./agendia-brand";

export function SarinArrival({ comingSoon = false }: { comingSoon?: boolean }) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [imagesReady, setImagesReady] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [messageIndex, setMessageIndex] = useState(0);
  const messages = [
    { title: "¡Hola, soy Sarin Bot!", text: comingSoon ? "Pronto te ayudaré a organizar tus citas en AgendIA." : "Te ayudo a organizar tus citas en AgendIA." },
    { title: "Tu negocio, a tu manera.", text: comingSoon ? "Configurarás tus servicios, profesionales y horarios." : "Configura tus servicios, profesionales y horarios." },
    { title: "Un enlace para tus clientes.", text: comingSoon ? "Compartirás tu espacio por mensaje o con un código QR." : "Comparte tu espacio por mensaje o con un código QR." },
    { title: "De la conversación a la cita.", text: comingSoon ? "Tus clientes podrán consultar servicios y horarios disponibles." : "Tus clientes consultan servicios y horarios disponibles." },
    { title: "Tu agenda, bajo control.", text: comingSoon ? "Podrás revisar tus citas y bloquear las horas que necesites." : "Revisa tus citas y bloquea las horas que necesites." },
  ];

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setMotionAllowed(!preference.matches);
    const updateVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    const images = Array.from(scene.querySelectorAll("img"));
    const updateImages = () => setImagesReady(images.every(image => image.complete && image.naturalWidth > 0));
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      if (entry) setInView(entry.isIntersecting && entry.intersectionRatio >= 0.3);
    }, { threshold: [0, 0.3] });

    updatePreference();
    updateVisibility();
    updateImages();
    preference.addEventListener("change", updatePreference);
    document.addEventListener("visibilitychange", updateVisibility);
    images.forEach(image => image.addEventListener("load", updateImages));
    if (observer) observer.observe(scene);
    else setInView(true);

    return () => {
      observer?.disconnect();
      preference.removeEventListener("change", updatePreference);
      document.removeEventListener("visibilitychange", updateVisibility);
      images.forEach(image => image.removeEventListener("load", updateImages));
    };
  }, []);

  const animated = motionAllowed && imagesReady;
  const motion = !animated ? "static" : inView && pageVisible ? "running" : "paused";
  const message = messages[messageIndex];

  function advanceMessage(event: AnimationEvent<HTMLDivElement>) {
    // Images also animate; only the actor's completed lap advances the text.
    if (event.target === event.currentTarget && event.animationName === "sarin-tour-flight") {
      setMessageIndex(index => (index + 1) % messages.length);
    }
  }

  return <div ref={sceneRef} className="sarin-arrival" data-motion={motion} data-message={messageIndex + 1}>
    <div className="sarin-arrival-content">
      <div className="sarin-arrival-actor" aria-hidden="true" onAnimationIteration={advanceMessage}>
        <Image src="/brand/sarin-flight.png" alt="" width={320} height={383} loading="eager" className="sarin-arrival-flight" />
        <Image src="/brand/sarin-welcome.png" alt="" width={320} height={480} loading="eager" className="sarin-arrival-landed" />
      </div>
      <div className="sarin-arrival-greeting"><div><p><strong>{message.title}</strong><span>{message.text}</span></p><BrandCredits /></div></div>
    </div>
  </div>;
}
