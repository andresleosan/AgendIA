import { act, createElement, useEffect, useInsertionEffect, useMemo, useState, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/app-shell';
import { resolveAdminLocation } from '@/lib/admin-navigation';

const state = vi.hoisted(() => ({ pathname: '/dashboard', search: '', navigationKey: 0, isSuperadmin: false, push: vi.fn() }));
vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ user: null, signOut: vi.fn(), isSuperadmin: state.isSuperadmin }) }));
vi.mock('@/components/consent-panel', () => ({ useAccountConsent: () => ({ active: true }), ConsentPanel: () => createElement('p', {}, 'Permisos de mi cuenta') }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname, useSearchParams: () => useMemo(() => new URLSearchParams(state.search), [state.search, state.navigationKey]), useRouter: () => ({ push: state.push }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: { children: ReactNode }) => createElement('a', props, children) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('workspace navigation', () => {
  let renderer: ReactTestRenderer;
  beforeEach(() => { state.pathname = '/dashboard'; state.search = ''; state.navigationKey = 0; state.isSuperadmin = false; state.push.mockClear(); });
  afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });
  async function shell(admin = false) {
    await act(async () => { renderer = create(createElement(AppShell, { admin, adminLocation: resolveAdminLocation('/admin', 'module=access&section=invitations', ''), children: 'Trabajo' })); });
  }

  it('ownerKeepsFourDestinations', async () => {
    await shell();
    const nav = renderer.root.findByProps({ 'aria-label': 'Navegación del negocio' });
    expect(nav.findAllByType('a').every(link => link.props.scroll === undefined)).toBe(true);
    expect(nav.findAllByType('a').map(link => link.props.href)).toEqual(['/dashboard', '/dashboard/onboarding', '/dashboard/qr-kit', '/dashboard/billing']);
    expect(nav.findAllByType('a').map(link => link.findAllByType('span')[0].children.join(''))).toEqual(['Mi agenda', 'Mi negocio', 'Enlace y QR', 'Suscripci\u00f3n']);
    expect(renderer.root.findByProps({ href: '#workspace-content' }).children).toEqual(['Saltar al contenido']);
    expect(JSON.stringify(renderer.toJSON())).toContain('Permisos de mi cuenta');
  });
  it('scheduleUsesBusinessContextWithoutFifthDestinationAndAdminIgnoresOverride', async () => {
    state.pathname = '/dashboard/schedule';
    await act(async () => { renderer = create(createElement(AppShell, { businessNavigationPath: '/dashboard/onboarding', children: 'Turnos' })); });
    const nav = renderer.root.findByProps({ 'aria-label': 'Navegación del negocio' });
    expect(nav.findAllByType('a')).toHaveLength(4);
    expect(nav.findByProps({ href: '/dashboard/onboarding' }).props['aria-current']).toBe('page');
    await act(async () => renderer.update(createElement(AppShell, { admin: true, businessNavigationPath: '/dashboard/onboarding', children: 'Admin' })));
    expect(renderer.root.findAllByType('a').some(link => link.props.href === '/dashboard/schedule')).toBe(false);
  });

  it('business navigation never exposes administration, including for a superadmin', async () => {
    await shell();
    expect(renderer.root.findAllByType('a').some(link => link.props.href === '/admin')).toBe(false);
    state.isSuperadmin = true;
    await act(async () => renderer.update(createElement(AppShell, { children: 'Trabajo' })));
    expect(renderer.root.findAllByType('a').some(link => String(link.props.href).startsWith('/admin'))).toBe(false);
    expect(renderer.root.findAllByType('a').filter(link => String(link.props.href).startsWith('/dashboard'))).toHaveLength(4);
  });

  it('activeModuleUsesValidatedSelection', async () => {
    state.isSuperadmin = true;
    state.pathname = '/admin';
    await shell(true);
    const nav = renderer.root.findByProps({ 'aria-label': 'Navegación de administración' });
    const active = nav.findAllByType('a').filter(link => link.props['aria-current'] === 'page');
    expect(active.map(link => link.props.href)).toEqual(['/admin?module=access&section=receipts']);
    expect(nav.findAllByType('a')).toHaveLength(7);
    expect(nav.findAllByType('a').filter(link => link.props.href !== '/dashboard').every(link => link.props.scroll === false)).toBe(true);
    expect(nav.findByProps({ href: '/dashboard' }).props.scroll).toBeUndefined();
  });

  it('ordinaryAccountDoesNotReceiveAdministrativeLinksEvenInAdminShell', async () => {
    await shell(true);
    expect(renderer.root.findAllByType('a').filter(link => String(link.props.href).startsWith('/admin'))).toHaveLength(0);
  });

  it('mobileMenuHasExpandedControlsAndEscapeReturn', async () => {
    const { WorkspaceNavigation } = await import('@/components/workspace-navigation');
    const focus = vi.fn();
    const props = { context: 'business' as const, items: [{ id: 'agenda', label: 'Mi agenda', href: '/dashboard' }], activeId: 'agenda', isSuperadmin: true };
    await act(async () => { renderer = create(createElement(WorkspaceNavigation, props), { createNodeMock: element => element.type === 'button' ? { focus } : null }); });
    const button = renderer.root.findByType('button');
    const nav = renderer.root.findByType('nav');
    expect(button.props['aria-expanded']).toBe(false);
    expect(button.props['aria-controls']).toBe(nav.props.id);
    expect(nav.props.className).not.toContain('overflow-x-auto');
    await act(async () => button.props.onClick());
    expect(button.props['aria-expanded']).toBe(true);
    await act(async () => nav.parent!.props.onKeyDown({ key: 'Escape', preventDefault: vi.fn() }));
    expect(button.props['aria-expanded']).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => button.props.onClick());
    await act(async () => renderer.root.findByProps({ href: '/dashboard' }).props.onClick({}));
    expect(button.props['aria-expanded']).toBe(false);
    expect(focus).toHaveBeenCalledTimes(2);
    await act(async () => button.props.onClick());
    await act(async () => renderer.update(createElement(WorkspaceNavigation, { ...props, activeId: 'business' })));
    expect(button.props['aria-expanded']).toBe(false);
  });

  it.each([
    { search: 'module=summary&section=overview', href: '/admin?module=summary&section=overview' },
    { search: 'focusPayment=old-payment', href: '/admin?module=access&section=receipts' },
  ])('same platform panel returns focus to the visible menu button ($search)', async ({ search, href }) => {
    const { AdminModulePanel } = await import('@/components/admin-module-panel');
    state.pathname = '/admin'; state.isSuperadmin = true;
    const focus = vi.fn();
    const tree = (query: string) => createElement(AppShell, { admin: true, adminLocation: resolveAdminLocation('/admin', query, ''), children: createElement(AdminModulePanel, { id: 'current', title: 'Tarea actual', description: '', active: true, children: 'Datos' }) });
    await act(async () => { renderer = create(tree(search), { createNodeMock: element => ['button', 'h2'].includes(String(element.type)) ? { focus: () => focus(element.type) } : null }); });
    const button = renderer.root.findAllByType('button').find(node => node.props['aria-controls'])!;
    await act(async () => button.props.onClick());
    await act(async () => renderer.root.findByProps({ href }).props.onClick({ button: 0 }));
    await act(async () => renderer.update(tree(href.split('?')[1])));
    expect(button.props['aria-expanded']).toBe(false);
    expect(focus.mock.calls).toEqual([['button']]);
  });
  it('a different section in the active module retains destination heading ownership', async () => {
    const { WorkspaceNavigation } = await import('@/components/workspace-navigation');
    const { AdminModulePanel } = await import('@/components/admin-module-panel');
    const focus = vi.fn();
    const tree = (receipts: boolean) => createElement('div', {}, createElement(WorkspaceNavigation, { context: 'platform', items: [{ id: 'access', label: 'Pagos y acceso', href: '/admin?module=access&section=receipts' }], activeId: 'access', isSuperadmin: true }), createElement(AdminModulePanel, { id: 'receipts', title: 'Comprobantes', description: '', active: receipts, children: 'Datos' }));
    await act(async () => { renderer = create(tree(false), { createNodeMock: element => ({ focus: () => focus(element.type) }) }); });
    await act(async () => renderer.root.findByType('button').props.onClick());
    await act(async () => renderer.root.findByProps({ href: '/admin?module=access&section=receipts' }).props.onClick({}));
    await act(async () => renderer.update(tree(true)));
    expect(focus.mock.calls.at(-1)).toEqual(['h2']);
    expect(renderer.root.findByType('button').props['aria-expanded']).toBe(false);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { currentTarget: { target: '_blank' } }])('modified selection keeps the mobile menu and focus (%j)', async event => {
    const { WorkspaceNavigation } = await import('@/components/workspace-navigation');
    const focus = vi.fn();
    await act(async () => { renderer = create(createElement(WorkspaceNavigation, { context: 'platform', items: [{ id: 'summary', label: 'Resumen', href: '/admin?module=summary&section=overview' }], activeId: 'summary', isSuperadmin: true }), { createNodeMock: () => ({ focus }) }); });
    const button = renderer.root.findByType('button');
    await act(async () => button.props.onClick());
    const preventDefault = vi.fn();
    await act(async () => renderer.root.findByProps({ href: '/admin?module=summary&section=overview' }).props.onClick({ ...event, preventDefault }));
    expect(button.props['aria-expanded']).toBe(true);
    expect(focus).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled();
  });
  it('a changed module owns heading focus after closing the menu', async () => {
    const { WorkspaceNavigation } = await import('@/components/workspace-navigation');
    const { AdminModulePanel } = await import('@/components/admin-module-panel');
    const focus = vi.fn();
    const tree = (activeId: string) => createElement('div', {}, createElement(WorkspaceNavigation, { context: 'platform', items: [{ id: 'summary', label: 'Resumen', href: '/admin' }, { id: 'businesses', label: 'Negocios', href: '/admin?module=businesses&section=list' }], activeId, isSuperadmin: true }), createElement(AdminModulePanel, { id: 'businesses', title: 'Negocios', description: '', active: activeId === 'businesses', children: 'Datos' }));
    await act(async () => { renderer = create(tree('summary'), { createNodeMock: element => ({ focus: () => focus(element.type) }) }); });
    const button = renderer.root.findByType('button');
    await act(async () => button.props.onClick());
    await act(async () => renderer.root.findByProps({ href: '/admin?module=businesses&section=list' }).props.onClick({}));
    expect(button.props['aria-expanded']).toBe(false); expect(focus).not.toHaveBeenCalled();
    await act(async () => renderer.update(tree('businesses')));
    expect(focus.mock.calls).toEqual([['h2']]);
  });

  it('hiddenPanelCannotReceiveKeyboardFocus', async () => {
    const { AdminModulePanel } = await import('@/components/admin-module-panel');
    await act(async () => { renderer = create(createElement(AdminModulePanel, { id: 'receipts', active: false, title: 'Comprobantes', description: 'Revisa pagos', children: createElement('button', {}, 'Confirmar') })); });
    const section = renderer.root.findByType('section');
    expect(section.props.hidden).toBe(true);
    expect(section.props.inert).toBe(true);
    expect(section.props['aria-labelledby']).toBe('receipts-title');
    expect(renderer.root.findByType('h2').props.tabIndex).toBe(-1);
    expect(section.props.className ?? '').not.toMatch(/\b(?:flex|grid|block)\b/);
  });

  it('panelSwitchKeepsChildInstanceAndDraft', async () => {
    const { AdminModulePanel } = await import('@/components/admin-module-panel');
    let mounts = 0;
    const focus = vi.fn();
    function Draft() {
      const [value, setValue] = useState('');
      useEffect(() => { mounts += 1; }, []);
      return createElement('input', { value, onChange: (event: { target: { value: string } }) => setValue(event.target.value) });
    }
    const panel = (active: boolean) => createElement(AdminModulePanel, { id: 'query', active, title: 'Consulta', description: 'Pregunta', children: createElement(Draft) });
    await act(async () => { renderer = create(panel(true), { createNodeMock: element => element.type === 'h2' ? { focus } : null }); });
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'Borrador sintético' } }));
    await act(async () => renderer.update(panel(false)));
    await act(async () => renderer.update(panel(true)));
    expect(renderer.root.findByType('input').props.value).toBe('Borrador sintético');
    expect(mounts).toBe(1);
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => renderer.update(panel(true)));
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('hashNotReadyDoesNotMountPrivateWorkspace', async () => {
    const { AdminNavigationBoundary } = await import('@/components/admin-navigation-boundary');
    let mounts = 0;
    const html = renderToString(createElement(AdminNavigationBoundary, { children: () => { mounts += 1; return createElement('p', {}, 'Privado'); } }));
    expect(mounts).toBe(0);
    expect(html).not.toContain('Privado');
    expect(html).toContain('Cargando');
  });

  it('queryAndHashCommitTogetherBeforeReadingNewDestination', async () => {
    const { AdminNavigationBoundary } = await import('@/components/admin-navigation-boundary');
    const browser = Object.assign(new EventTarget(), { location: { pathname: '/admin', search: '?focusPayment=receipt_1', hash: '#payment-receipt_1' } });
    vi.stubGlobal('window', browser);
    state.pathname = '/admin';
    state.search = 'focusPayment=receipt_1';
    const selections: Array<{ payment: string | null; error: string | null }> = [];
    function CommittedUrl({ hash }: { hash: string }) {
      // Next's HistoryUpdater commits canonicalUrl in useInsertionEffect,
      // after the child already rendered with the new query hook value.
      useInsertionEffect(() => { browser.location.hash = hash; browser.location.search = `?${state.search}`; }, [hash]);
      return createElement(AdminNavigationBoundary, { children: ({ location }) => {
        selections.push({ payment: location.focusPayment, error: location.error });
        return createElement('p', {}, location.focusPayment);
      } });
    }
    await act(async () => { renderer = create(createElement(CommittedUrl, { hash: '#payment-receipt_1' })); });
    state.search = 'focusPayment=receipt_2';
    await act(async () => renderer.update(createElement(CommittedUrl, { hash: '#payment-receipt_2' })));
    expect(selections.every(selection => selection.error === null)).toBe(true);
    expect(selections.at(-1)?.payment).toBe('receipt_2');
    state.search = 'focusPayment=receipt_1';
    await act(async () => renderer.update(createElement(CommittedUrl, { hash: '#payment-receipt_1' })));
    expect(selections.every(selection => selection.error === null)).toBe(true);
    expect(selections.at(-1)?.payment).toBe('receipt_1');
    // Native hashchange may arrive before Next commits its query hook update.
    browser.location.search = '?focusPayment=receipt_2';
    browser.location.hash = '#payment-receipt_2';
    await act(async () => browser.dispatchEvent(new Event('hashchange')));
    expect(selections.every(selection => selection.error === null)).toBe(true);
    expect(selections.at(-1)?.payment).toBe('receipt_2');
    expect(state.push).not.toHaveBeenCalled();
  });

  it('nextHashOnlyUpdateSelectsTargetWithoutHashEventAndKeepsWorkspace', async () => {
    const { AdminNavigationBoundary } = await import('@/components/admin-navigation-boundary');
    const browser = Object.assign(new EventTarget(), { location: { pathname: '/admin', search: '', hash: '' } });
    vi.stubGlobal('window', browser);
    state.pathname = '/admin';
    let mounts = 0;
    function Workspace({ module, target }: { module: string; target: string | null }) {
      const [draft, setDraft] = useState('');
      useEffect(() => { mounts += 1; }, []);
      return createElement('div', {}, createElement('p', { 'data-target': target }, module), createElement('input', { value: draft, onChange: () => setDraft('Retained draft') }));
    }
    function CommittedUrl({ hash }: { hash: string }) {
      // Next changes canonicalUrl/searchParams identity for a hash-only update
      // and commits with History API calls, without a native hashchange event.
      useInsertionEffect(() => { browser.location.hash = hash; }, [hash]);
      return createElement(AdminNavigationBoundary, { children: ({ location }) => createElement(Workspace, { module: location.module, target: location.targetId }) });
    }
    await act(async () => { renderer = create(createElement(CommittedUrl, { hash: '' })); });
    expect(renderer.root.findByType('p').children).toEqual(['summary']);
    await act(async () => renderer.root.findByType('input').props.onChange());
    state.navigationKey += 1;
    await act(async () => renderer.update(createElement(CommittedUrl, { hash: '#business-record_1' })));
    expect(renderer.root.findByType('p').children).toEqual(['businesses']);
    expect(renderer.root.findByType('p').props['data-target']).toBe('business-record_1');
    state.navigationKey += 1;
    await act(async () => renderer.update(createElement(CommittedUrl, { hash: '#business-record_2' })));
    expect(renderer.root.findByType('p').props['data-target']).toBe('business-record_2');
    state.navigationKey += 1;
    await act(async () => renderer.update(createElement(CommittedUrl, { hash: '' })));
    expect(renderer.root.findByType('p').children).toEqual(['summary']);
    expect(renderer.root.findByType('p').props['data-target']).toBeNull();
    expect(renderer.root.findByType('input').props.value).toBe('Retained draft');
    expect(mounts).toBe(1);
    expect(state.pathname).toBe('/admin');
    expect(state.search).toBe('');
    expect(state.push).not.toHaveBeenCalled();
  });

  it('backForwardUpdatesSelectionWithoutEffect', async () => {
    const { AdminNavigationBoundary } = await import('@/components/admin-navigation-boundary');
    const events = new EventTarget();
    const browser = Object.assign(events, { location: { pathname: '/admin', search: '?focusPayment=receipt_1', hash: '#payment-receipt_1' } });
    vi.stubGlobal('window', browser);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    state.pathname = '/admin';
    state.search = 'focusPayment=receipt_1';
    let mounts = 0;
    function Workspace({ section, focusPayment, navigate }: { section: string; focusPayment: string | null; navigate: () => void }) {
      const [draft, setDraft] = useState('');
      useEffect(() => { mounts += 1; }, []);
      return createElement('div', {}, createElement('p', { 'data-payment': focusPayment }, section), createElement('input', { value: draft, onChange: () => setDraft('Pendiente') }), createElement('button', { onClick: navigate }, 'Ir'));
    }
    const tree = () => createElement(AdminNavigationBoundary, { children: ({ location, navigate }) => createElement(Workspace, { section: location.section, focusPayment: location.focusPayment, navigate: () => navigate({ module: 'intelligence', section: 'provider' }) }) });
    await act(async () => { renderer = create(tree()); });
    expect(renderer.root.findByType('p').children).toEqual(['receipts']);
    await act(async () => renderer.root.findByType('input').props.onChange());
    await act(async () => renderer.root.findByType('button').props.onClick());
    expect(state.push).toHaveBeenCalledWith('/admin?module=intelligence&section=provider', { scroll: false });
    browser.location.hash = '#payment-receipt_2';
    state.search = 'focusPayment=receipt_2';
    browser.location.search = '?focusPayment=receipt_2';
    await act(async () => renderer.update(tree()));
    expect(renderer.root.findByType('p').children).toEqual(['receipts']);
    expect(renderer.root.findByType('p').props['data-payment']).toBe('receipt_2');
    browser.location.hash = '#payment-receipt_1';
    state.search = 'focusPayment=receipt_1';
    browser.location.search = '?focusPayment=receipt_1';
    await act(async () => renderer.update(tree()));
    expect(renderer.root.findByType('p').props['data-payment']).toBe('receipt_1');
    expect(renderer.root.findByType('input').props.value).toBe('Pendiente');
    browser.location.hash = '';
    state.search = 'module=businesses&section=list';
    browser.location.search = '?module=businesses&section=list';
    await act(async () => renderer.update(tree()));
    expect(renderer.root.findByType('p').children).toEqual(['list']);
    state.search = 'focusPayment=receipt_1';
    browser.location.search = '?focusPayment=receipt_1';
    browser.location.hash = '#payment-receipt_1';
    await act(async () => { browser.dispatchEvent(new Event('hashchange')); renderer.update(tree()); });
    expect(renderer.root.findByType('p').children).toEqual(['receipts']);
    expect(renderer.root.findByType('input').props.value).toBe('Pendiente');
    expect(mounts).toBe(1);
    // A Next navigation may clear a hash without firing hashchange. A later
    // hash-only visit must still resolve even if it matches the entry hash.
    state.search = '';
    browser.location.search = '';
    browser.location.hash = '';
    await act(async () => renderer.update(tree()));
    expect(renderer.root.findByType('p').children).toEqual(['overview']);
    browser.location.hash = '#payment-receipt_1';
    await act(async () => browser.dispatchEvent(new Event('hashchange')));
    expect(renderer.root.findByType('p').children).toEqual(['receipts']);
    expect(mounts).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.push).toHaveBeenCalledTimes(1);
  });
});
