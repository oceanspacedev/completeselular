import { useCallback, useEffect, useState } from 'react'

// "Aktifkan lokasi" for the nearest-store features (Toko Cabang, the home page link). The
// position comes from the browser's geolocation prompt, stays on this device (localStorage, one
// day) and is only used to measure distances here: it is never sent anywhere.
const KEY = 'cs-location'
const MAX_AGE = 24 * 60 * 60 * 1000

function read() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return saved && Date.now() - saved.at < MAX_AGE ? saved : null
  } catch {
    return null
  }
}

// Every component using the hook follows the same position (turning it on in one updates the other)
const listeners = new Set()
let current = typeof window === 'undefined' ? null : read()
function set(next) {
  current = next
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next))
    else localStorage.removeItem(KEY)
  } catch {
    // Private mode or blocked storage: the position just lasts until the page closes
  }
  listeners.forEach((l) => l(next))
}

//   status  'idle' | 'locating' | 'on' | 'denied' | 'unavailable'
//   position { lat, lng } while 'on'
//   enable() asks the browser; off() forgets the position
export function useMyLocation() {
  const [position, setPosition] = useState(current)
  const [status, setStatus] = useState(current ? 'on' : 'idle')

  useEffect(() => {
    const onChange = (next) => {
      setPosition(next)
      setStatus(next ? 'on' : 'idle')
    }
    listeners.add(onChange)
    return () => listeners.delete(onChange)
  }, [])

  const enable = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus('unavailable')
      return
    }
    setStatus('locating')
    navigator.geolocation.getCurrentPosition(
      (p) => set({ lat: p.coords.latitude, lng: p.coords.longitude, at: Date.now() }),
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 },
    )
  }, [])

  const off = useCallback(() => set(null), [])

  return { status, position, enable, off }
}

// Straight-line distance in km (haversine); good enough to rank stores a few km apart
export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

// "800 m", "2,4 km", "36 km"
export function formatDistance(km) {
  if (km < 1) return `${Math.max(100, Math.round((km * 1000) / 100) * 100)} m`
  return `${km.toLocaleString('id-ID', { maximumFractionDigits: km < 10 ? 1 : 0 })} km`
}
