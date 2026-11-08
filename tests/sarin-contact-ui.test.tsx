import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MarketingHome } from '@/components/marketing-home';
import HelpPage from '@/app/ayuda/page';
vi.mock('@/components/platform-whatsapp-link', () => ({ PlatformWhatsAppLink: () => null }));

vi.mock('@/lib/sarin-contact', () => ({
  sarinContact: { phone: '+12345678', displayPhone: '+1 234 5678' },
  sarinWhatsAppUrl: 'https://wa.me/12345678',
}));

describe('public SarinBot support contact', () => {
  it.each([false, true])('offers support with safe external attributes on marketing, standalone=%s', standalone => {
    const html = renderToStaticMarkup(createElement(MarketingHome, { standalone }));
    const anchor = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map(match => match[0]).find(value => value.includes('Contactar a Sarin Bot por WhatsApp')) ?? '';
    expect(anchor).toContain('href="https://wa.me/12345678"');
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noopener noreferrer"');
    expect(anchor).toContain('referrerPolicy="no-referrer"');
    expect(anchor).toContain('class="agenda-text-link"');
    expect(anchor).toContain('aria-hidden="true"');
  });

  it('uses the support display phone in help and preserves a separate legal email', () => {
    const html = renderToStaticMarkup(createElement(HelpPage));
    const anchor = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map(match => match[0]).find(value => value.includes('WhatsApp de SarinBot:')) ?? '';
    expect(anchor).toContain('href="https://wa.me/12345678"');
    expect(anchor).toContain('WhatsApp de SarinBot: +1 234 5678');
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noopener noreferrer"');
    expect(anchor).toContain('referrerPolicy="no-referrer"');
    expect(html.includes('href="mailto:')).toBe(true);
  });
});
