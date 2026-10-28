export function IconDefinitions() {
  return (<svg style={{ display: 'none' }} aria-hidden="true"><defs>
<symbol id="leaf" viewBox="0 0 24 24"><path d="M20 3C7 2 2 9 6 16c6 5 15-1 14-13Z"/><path d="m4 21 12-13M10 15v-5m0 5h5"/></symbol>
<symbol id="stop" viewBox="0 0 24 24"><path d="m8 3-5 5v8l5 5h8l5-5V8l-5-5Z"/><rect x="9" y="9" width="6" height="6" rx=".5"/></symbol>
<symbol id="play" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/></symbol>
<symbol id="download" viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6"/></symbol>
<symbol id="log" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h4"/></symbol>
<symbol id="db" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/></symbol>
<symbol id="settings" viewBox="0 0 24 24">
  <path d="m9.5 3-.6 2.4-1.5.9L5 5.6 2.5 10l1.8 1.7v1.7L2.5 15 5 19.4l2.4-.7 1.5.9.6 2.4h5l.6-2.4 1.5-.9 2.4.7 2.5-4.4-1.8-1.6v-1.7L21.5 10 19 5.6l-2.4.7-1.5-.9L14.5 3Z" />
  <circle cx="12" cy="12.5" r="3" />
</symbol>
</defs></svg>)
}

export function Icon({ name }: { name: 'leaf' | 'stop' | 'play' | 'download' | 'log' | 'db' | 'settings' }) {
  return <svg aria-hidden="true"><use href={`#${name}`} /></svg>
}
