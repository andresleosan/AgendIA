import "./agendia-brand.css";

export function AgendiaBrand({ compact = false }: { compact?: boolean }) {
  return <span className="agendia-brand">
    <span className="agendia-wordmark" role="img" aria-label="AgendIA">Agend<span className="agendia-wordmark-ai">IA</span></span>
    {!compact && <span className="agendia-tagline">Tus clientes agendan, la IA trabaja</span>}
  </span>;
}

export function BrandCredits({ className = "" }: { className?: string }) {
  return <div className={`agendia-credits ${className}`}>
    <p>Asistente virtual: Sarin Bot</p>
    <a href="https://www.alsdevstudio.com">Desarrollado por ALS Dev Studio</a>
  </div>;
}
