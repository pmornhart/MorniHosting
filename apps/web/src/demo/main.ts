import { DEMO_PASSWORD, DEMO_USER, installDemoBackend } from './backend';
import { setTeamDemoRole, TEAM_DEMO_EVENT, teamDemoRole } from './team-demo';

/** Demo entry: the pretend server first, then the real app on top of it. */

installDemoBackend();

const banner = document.createElement('div');
banner.setAttribute('role', 'note');
banner.style.cssText = [
  'position:fixed',
  'left:50%',
  'bottom:calc(10px + env(safe-area-inset-bottom, 0px))',
  'transform:translateX(-50%)',
  'z-index:90',
  'max-width:calc(100vw - 32px)',
  'padding:7px 14px',
  'border-radius:999px',
  'border:1px solid var(--border)',
  'background:var(--popover)',
  'color:var(--muted-foreground)',
  'font:12px/1.4 Manrope,system-ui,sans-serif',
  'box-shadow:0 8px 24px rgba(0,0,0,.25)',
  'text-align:center',
].join(';');
const TEAM = location.hash === '#team' || (window as { mhDemoStart?: string }).mhDemoStart === 'team';
banner.innerHTML = TEAM
  ? '<b style="color:var(--primary)">Demo</b> · Team-Dashboard von /teamdashboard · Ansicht als '
  : `<b style="color:var(--primary)">Demo</b> · Anmelden mit <b style="color:var(--foreground)">${DEMO_USER}</b> / <b style="color:var(--foreground)">${DEMO_PASSWORD}</b> oder Passkey · nichts wird gespeichert`;
/** Team demo: switch between what an owner and a moderator see. */
const roleButtons = (['owner', 'moderator'] as const).map((role) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = role === 'owner' ? 'Owner' : 'Moderator';
  button.style.cssText =
    'margin:0 2px;border:1px solid var(--border);border-radius:999px;padding:1px 9px;font:inherit;cursor:pointer;color:inherit';
  const paint = (): void => {
    const on = teamDemoRole() === role;
    button.style.background = on ? 'var(--primary)' : 'transparent';
    button.style.setProperty('color', on ? 'var(--primary-foreground)' : 'inherit', 'important');
  };
  button.addEventListener('click', () => {
    setTeamDemoRole(role);
    // The team page asks again right away (see useTeamBoard).
    window.dispatchEvent(new Event(TEAM_DEMO_EVENT));
    roleButtons.forEach((b) => b.paint());
  });
  paint();
  return { element: button, paint };
});
if (TEAM) banner.append(...roleButtons.map((b) => b.element));
const close = document.createElement('button');
close.type = 'button';
close.textContent = '×';
close.setAttribute('aria-label', 'Hinweis schließen');
close.style.cssText =
  'margin-left:8px;border:0;background:none;color:inherit;font:inherit;font-size:15px;line-height:1;cursor:pointer;padding:0 2px';
close.addEventListener('click', () => banner.remove());
banner.append(close);
document.body.append(banner);

await import('../main');
