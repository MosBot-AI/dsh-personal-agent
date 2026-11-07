export const inboxStyles = `
.dshpa-inbox {
  --dshpa-base: var(--dsw-alias-bg-base, #fff);
  --dshpa-layer: var(--dsw-alias-bg-layer-1, #f7f8fa);
  --dshpa-line: var(--dsw-alias-border-l1, #e2e5eb);
  --dshpa-ink: var(--dsw-alias-label-primary, #20252e);
  --dshpa-muted: var(--dsw-alias-label-secondary, #596272);
  --dshpa-accent: var(--dsw-alias-brand-text, #2a61df);
  --dshpa-hover: var(--dsw-alias-interactive-bg-hover, #eff2f7);
  --dshpa-danger: var(--dsw-alias-state-danger, #b63140);
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
  padding: clamp(16px, 3vw, 40px);
  background: var(--dshpa-base);
  color: var(--dshpa-ink);
  font-size: 14px;
  line-height: 1.5;
}
.dshpa-inbox *, .dshpa-inbox *::before, .dshpa-inbox *::after { box-sizing: border-box; }
.dshpa-inbox :is(h1,h2,h3,h4,p,dl,pre) { margin: 0; }
.dshpa-inbox h1 { font-size: clamp(28px, 3vw, 38px); line-height: 1.16; letter-spacing: -.03em; }
.dshpa-inbox h2 { font-size: 17px; font-weight: 650; }
.dshpa-inbox h3 { font-size: 14px; font-weight: 650; }
.dshpa-inbox h4 { font-size: 13px; font-weight: 650; }
.dshpa-kicker { color: var(--dshpa-accent); font-size: 11px; font-weight: 650; letter-spacing: .1em; text-transform: uppercase; }
.dshpa-muted { color: var(--dshpa-muted); }
.dshpa-header, .dshpa-columns, .dshpa-banner { width: min(100%, 1140px); margin-inline: auto; }
.dshpa-header { display: flex; gap: 16px; justify-content: space-between; align-items: end; padding: 0 0 22px; border-bottom: 1px solid var(--dshpa-line); }
.dshpa-header h1 { margin: 5px 0 4px; }
.dshpa-header-actions, .dshpa-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dshpa-header-actions { justify-content: flex-end; flex-shrink: 0; }
.dshpa-connection, .dshpa-status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--dshpa-muted); font-size: 11px; font-weight: 600; }
.dshpa-connection::before, .dshpa-status::before { width: 6px; height: 6px; flex: none; border-radius: 50%; background: currentColor; content: ''; }
.dshpa-connection[data-ready="true"], .dshpa-status:is([data-state="running"],[data-state="verifying"],[data-state="accepted"]) { color: var(--dshpa-accent); }
.dshpa-status:is([data-state="failed"],[data-state="uncertain"],[data-state="blocked"]) { color: var(--dshpa-danger); }
.dshpa-status:is([data-state="completed"],[data-state="delivered"],[data-state="read"]) { color: var(--dsw-alias-state-success, #21805c); }
.dshpa-banner { padding: 10px 12px; border-radius: 8px; margin-block: 14px 0 !important; background: var(--dshpa-layer); color: var(--dshpa-muted); }
.dshpa-columns { display: grid; grid-template-columns: minmax(260px, .85fr) minmax(300px, 1.15fr); gap: clamp(20px, 4vw, 48px); margin-top: 24px; }
.dshpa-today, .dshpa-work, .dshpa-detail { display: grid; align-content: start; min-width: 0; gap: 16px; }
.dshpa-section { display: grid; gap: 10px; padding: 0 0 16px; border-bottom: 1px solid var(--dshpa-line); }
.dshpa-section h2 { display: flex; align-items: center; gap: 9px; }
.dshpa-section h2 > span { background: var(--dshpa-layer); color: var(--dshpa-muted); font-size: 11px; line-height: 1; padding: 4px 6px; border-radius: 12px; }
.dshpa-card, .dshpa-empty { display: grid; min-width: 0; gap: 10px; padding: 14px; border: 1px solid var(--dshpa-line); border-radius: 11px; background: var(--dshpa-layer); overflow-wrap: anywhere; }
.dshpa-attention { border-inline-start: 3px solid var(--dshpa-accent); }
.dshpa-summary { font-weight: 550; }
.dshpa-knowledge pre { white-space: pre-wrap; }
.dshpa-knowledge pre, .dshpa-knowledge code { overflow-wrap: anywhere; }
.dshpa-fields { display: grid; grid-template-columns: minmax(74px, 28%) minmax(0, 1fr); gap: 5px 10px; font-size: 12px; }
.dshpa-fields dt { color: var(--dshpa-muted); }
.dshpa-fields dd { margin: 0; }
.dshpa-fields code { font-size: 11px; overflow-wrap: anywhere; }
.dshpa-preview > summary, .dshpa-projects > summary, .dshpa-usage > summary { cursor: pointer; color: var(--dshpa-muted); font-size: 12px; }
.dshpa-preview pre { background: var(--dshpa-base); border-radius: 7px; padding: 8px 9px; margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 160px; overflow: auto; font-size: 12px; }
.dshpa-task-list, .dshpa-artifacts, .dshpa-deliveries, .dshpa-projects ul { margin: 0; padding: 0; list-style: none; }
.dshpa-task-list { display: grid; gap: 6px; }
.dshpa-inbox button, .dshpa-inbox input, .dshpa-inbox select, .dshpa-inbox textarea {
  color: inherit; font: inherit; line-height: 1.35; border: 1px solid var(--dshpa-line); border-radius: 7px; background: var(--dshpa-base);
}
.dshpa-inbox button { cursor: pointer; padding: 7px 11px; min-height: 32px; }
.dshpa-inbox button:not(:disabled):hover { background: var(--dshpa-hover); }
.dshpa-inbox button:disabled { cursor: default; opacity: .55; }
.dshpa-inbox :is(button,input,select,textarea,summary):focus-visible { outline: 2px solid var(--dshpa-accent); outline-offset: 2px; }
.dshpa-inbox button.dshpa-primary { color: var(--dsw-alias-label-primary-inverted, #fff); border-color: transparent; background: var(--dsw-alias-button-primary-fill, #2a61df); }
.dshpa-inbox button.dshpa-primary:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover, #2353c2); }
.dshpa-inbox button.dshpa-danger { color: var(--dshpa-danger); }
.dshpa-inbox button.dshpa-task-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left; padding: 10px 11px; overflow-wrap: anywhere; }
.dshpa-inbox button.dshpa-task-row[aria-current="true"] { border-color: var(--dshpa-accent); background: var(--dshpa-hover); }
.dshpa-form { display: grid; gap: 10px; }
.dshpa-form label { display: grid; gap: 4px; color: var(--dshpa-muted); font-size: 12px; }
.dshpa-inbox :is(input,select,textarea) { width: 100%; padding: 7px 9px; font-size: 14px; color: var(--dshpa-ink); min-width: 0; }
.dshpa-inbox textarea { resize: vertical; }
.dshpa-form button { justify-self: start; }
.dshpa-detail-head { display: flex; gap: 12px; align-items: start; justify-content: space-between; min-width: 0; }
.dshpa-detail-head > div { min-width: 0; }
.dshpa-detail-head h2 { font-size: 23px; line-height: 1.25; margin-top: 4px; overflow-wrap: anywhere; }
.dshpa-detail-head h2:focus { outline: none; }
.dshpa-artifacts li, .dshpa-projects li { display: grid; gap: 2px; border-top: 1px solid var(--dshpa-line); padding: 8px 0; }
.dshpa-artifacts li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dshpa-artifacts small { display: block; color: var(--dshpa-muted); }
.dshpa-deliveries { display: flex; flex-wrap: wrap; gap: 8px; }
.dshpa-projects ul { padding-top: 8px; }
@media (max-width: 860px) {
  .dshpa-columns { grid-template-columns: minmax(0, 1fr); gap: 24px; }
}
@media (max-width: 500px) {
  .dshpa-header { align-items: start; flex-direction: column; }
  .dshpa-header-actions { justify-content: start; }
}
@media (pointer: coarse) {
  .dshpa-inbox :is(input,select,textarea) { font-size: 16px; }
}
`
