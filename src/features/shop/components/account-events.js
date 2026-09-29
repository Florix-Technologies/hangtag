// Account button, account menu and settings dialog: clicks, profile form, Escape.
import { closeAcctMenu, openAcctMenu } from './account-menu.js';
import { closeSettings, installSettingsEvents, onProfileSubmit, openSettings } from './settings-modal.js';
import { downloadBackup } from '../../backup/services/backup-file.js';
import { exportCsv } from '../../reports/services/csv-export.js';
import { aEl } from '../../../shared/components/gate.js';
import { $ } from '../../../shared/dom.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { storage } from '../../../shared/state/persistence.js';
import { requestSignOut } from '../../../shared/ui/session-actions.js';
import { installTeamEvents } from './team-settings.js';
import { openCashForm } from '../../finance/components/cash-form.js';

/* Registered once at start-up (app/main.js). */
export function installAccountMenuEvents(){
  installTeamEvents(openSettings);   // Settings → Team & devices, Roles & permissions (back leads to the settings)
  installSettingsEvents();           // Settings: the section bar, Capabilities
  aEl("acctBtn").addEventListener("click", e => { e.stopPropagation(); if(aEl("acctMenu").hidden) openAcctMenu(); else closeAcctMenu(); });
  aEl("acctMenu").addEventListener("click", e => {
    const b = e.target.closest("[data-am]"); if(!b) return;
    const act = b.dataset.am; closeAcctMenu();
    if(act === "settings") openSettings();
    else if(act === "backup") downloadBackup();
    else if(act === "signout") requestSignOut();
    else if(act.startsWith("cash:")) openCashForm(act.slice(5));   // a team member's cash drawer (no Reports tab)
  });
  document.addEventListener("click", e => {
    if(!aEl("acctMenu").hidden && !e.target.closest(".acctwrap")) closeAcctMenu();
    if(e.target.closest("[data-welcome-close]")){ storage.set("hangtag_welcome_hidden", dayKey(Date.now())); aEl("welcome").hidden = true; }
    if(e.target.matches("[data-settings-scrim]") || e.target.closest("[data-settings-close]")) closeSettings();
    const sa = e.target.closest("[data-settings-act]");
    if(sa){ const a = sa.dataset.settingsAct; if(a === "backup") downloadBackup(); else if(a === "export") exportCsv(); else if(a === "signout"){ closeSettings(); requestSignOut(); } }
  });
  document.addEventListener("submit", e => { if(e.target.id === "profileForm"){ e.preventDefault(); onProfileSubmit(e.target); } });
  document.addEventListener("keydown", e => {
    if(e.key !== "Escape") return;
    if(!aEl("acctMenu").hidden){ closeAcctMenu(); aEl("acctBtn").focus(); }
    else if($("#modalHost").innerHTML) closeSettings();
  });
}
