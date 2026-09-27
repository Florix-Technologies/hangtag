// Render bus: features ask for a full re-render or a tab switch without importing app/ (app/navigation.js provides the "renderer" port).
import { use } from '../di/services.js';

export function renderAll(){ use("renderer").renderAll(); }
export function setTab(t){ use("renderer").setTab(t); }
