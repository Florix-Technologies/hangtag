// The "eventRepository" port: events are kept on this device first (the state store + its storage), then queued for
// upload (hangtag_events). The database refuses deleting an event that has bills. Dependencies come from app/container.js.

/* store: the state store · persist: { saveEvents } · outbox: { enqueue, dropQueued } */
export function createLocalFirstEventRepository({ store, persist, outbox }){
  return {
    list: () => Object.values(store.events || {}),
    get: id => (store.events || {})[id] || null,
    save(ev){
      if(!store.events) store.events = {};
      store.events[ev.id] = ev; persist.saveEvents();
      outbox.enqueue({ type: "event", id: ev.id, ev });
      return ev;
    },
    remove(id){
      delete store.events[id]; persist.saveEvents();
      outbox.dropQueued(q => q.type === "event" && q.id === id);
      outbox.enqueue({ type: "eventdel", id });
    },
  };
}
