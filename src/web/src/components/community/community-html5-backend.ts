import { HTML5Backend } from "react-dnd-html5-backend"

function sortingEventRoot(root: Node): Node {
  const listeners = new WeakMap<EventListenerOrEventListenerObject, EventListener>()
  const wrap = (listener: EventListenerOrEventListenerObject) => {
    let wrapped = listeners.get(listener)
    if (!wrapped) {
      wrapped = (event) => {
        const transfer = (event as DragEvent).dataTransfer
        if (transfer && Array.from(transfer.types).includes("Files")) {
          if (event.type === "dragover" || event.type === "drop") {
            event.preventDefault()
            transfer.dropEffect = "none"
          }
          return
        }
        if (typeof listener === "function") listener.call(root, event)
        else listener.handleEvent(event)
      }
      listeners.set(listener, wrapped)
    }
    return wrapped
  }
  return new Proxy(root, {
    get(target, property) {
      if (property === "addEventListener") {
        return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => target.addEventListener(type, wrap(listener), options)
      }
      if (property === "removeEventListener") {
        return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => target.removeEventListener(type, listeners.get(listener) ?? listener, options)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export const CommunityHTML5Backend: typeof HTML5Backend = (manager, context, options) => {
  const root = options?.rootElement ?? context?.document ?? globalThis.document
  return HTML5Backend(manager, context, root ? { ...options, rootElement: sortingEventRoot(root) } : options)
}
