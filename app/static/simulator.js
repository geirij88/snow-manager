let simMap = null
let simDriverMarker = null
let simRouteLine = null
let simRouteMarkers = []
let simOrders = []
let simCurrentActiveOrder = null
let simCurrentNextOrder = null
let simSimulatedPosition = null

function simLog(message) {
    const logEl = document.getElementById('sim-log')
    if (!logEl) return

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    logEl.textContent = `[${timestamp}] ${message}\n` + logEl.textContent
}

function simSetStatus(text) {
    const el = document.getElementById('sim-status')
    if (el) el.textContent = text
}

function simSetPositionText(lat, lng) {
    const el = document.getElementById('sim-position')
    if (el) el.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`
}

function simSetDistanceText(text) {
    const el = document.getElementById('sim-distance')
    if (el) el.textContent = text
}

function simToRadians(value) {
    return value * (Math.PI / 180)
}

function simDistanceKm(a, b) {
    const lat1 = Number(a.lat)
    const lng1 = Number(a.lng)
    const lat2 = Number(b.lat)
    const lng2 = Number(b.lng)

    const R = 6371
    const dLat = simToRadians(lat2 - lat1)
    const dLng = simToRadians(lng2 - lng1)

    const aa =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(simToRadians(lat1)) * Math.cos(simToRadians(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2)

    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa))
    return R * c
}

function simGetLocalDateKey() {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function simIsToday(order) {
    if (!order || !order.job_date) return false
    return String(order.job_date).slice(0, 10) === simGetLocalDateKey()
}

function simGetRouteOrders(orders) {
    return orders.filter(order =>
        simIsToday(order) &&
        ['routed', 'active'].includes(order.status) &&
        order.lat && order.lng
    )
}

function simGetOptimizedOrders(orders) {
    const routeJobs = simGetRouteOrders(orders)
    if (routeJobs.length <= 1) return routeJobs

    const activeJob = routeJobs.find(order => order.status === 'active') || null
    const remaining = routeJobs.filter(order => !activeJob || order.id !== activeJob.id)
    const result = []

    let current = activeJob || remaining.shift()
    if (!current) return routeJobs
    result.push(current)

    while (remaining.length > 0) {
        let closestIndex = 0
        let closestDistance = simDistanceKm(current, remaining[0])

        for (let i = 1; i < remaining.length; i += 1) {
            const candidateDistance = simDistanceKm(current, remaining[i])
            if (candidateDistance < closestDistance) {
                closestDistance = candidateDistance
                closestIndex = i
            }
        }

        current = remaining.splice(closestIndex, 1)[0]
        result.push(current)
    }

    return result
}

function simUpdateCurrentOrders() {
    const optimized = simGetOptimizedOrders(simOrders)
    simCurrentActiveOrder = optimized.find(order => order.status === 'active') || null

    if (simCurrentActiveOrder) {
        const activeIndex = optimized.findIndex(order => order.id === simCurrentActiveOrder.id)
        simCurrentNextOrder = activeIndex >= 0 ? (optimized[activeIndex + 1] || null) : null
        simSetStatus(`Aktiv jobb: ${simCurrentActiveOrder.address || 'Ukjent'}`)
    } else {
        simCurrentNextOrder = optimized[0] || null
        simSetStatus(simCurrentNextOrder ? `Neste stopp: ${simCurrentNextOrder.address || 'Ukjent'}` : 'Ingen rute lastet')
    }

    if (simSimulatedPosition && simCurrentNextOrder) {
        const distance = simDistanceKm(simSimulatedPosition, simCurrentNextOrder)
        simSetDistanceText(`${distance.toFixed(2)} km`)
    } else {
        simSetDistanceText('--')
    }
}

function simClearRoute() {
    simRouteMarkers.forEach(marker => {
        if (simMap) simMap.removeLayer(marker)
    })
    simRouteMarkers = []

    if (simRouteLine && simMap) {
        simMap.removeLayer(simRouteLine)
    }
    simRouteLine = null
}

function simEnsureMap() {
    if (simMap) return

    simMap = L.map('simulator-map').setView([59.1248, 11.3875], 12)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(simMap)
}

function simDrawRoute() {
    if (!simMap) return

    simClearRoute()

    const optimized = simGetOptimizedOrders(simOrders)
    const coords = []

    optimized.forEach((order, index) => {
        const lat = Number(order.lat)
        const lng = Number(order.lng)
        coords.push([lat, lng])

        const marker = L.circleMarker([lat, lng], {
            radius: 10,
            fillColor: order.status === 'active' ? '#16a34a' : '#2563eb',
            color: '#ffffff',
            weight: 2,
            fillOpacity: 0.95
        }).addTo(simMap)

        marker.bindTooltip(`${index + 1}`, {
            permanent: true,
            direction: 'center'
        })

        marker.bindPopup(`<b>#${index + 1} ${order.address || ''}</b>`) 
        simRouteMarkers.push(marker)
    })

    if (coords.length > 1) {
        simRouteLine = L.polyline(coords, {
            color: '#2e7dff',
            weight: 4,
            opacity: 0.85
        }).addTo(simMap)
    }

    const boundsPoints = [...coords]
    if (simSimulatedPosition) {
        boundsPoints.push([simSimulatedPosition.lat, simSimulatedPosition.lng])
    }

    if (boundsPoints.length > 0) {
        const bounds = L.latLngBounds(boundsPoints)
        if (bounds.isValid()) {
            simMap.fitBounds(bounds, { padding: [40, 40] })
        }
    }
}

function simCreateDriverMarker() {
    if (!simMap || !simSimulatedPosition) return

    if (!simDriverMarker) {
        simDriverMarker = L.circleMarker([simSimulatedPosition.lat, simSimulatedPosition.lng], {
            radius: 11,
            fillColor: '#f59e0b',
            color: '#ffffff',
            weight: 3,
            fillOpacity: 1
        }).addTo(simMap)
        simDriverMarker.bindPopup('Simulert fører')
    } else {
        simDriverMarker.setLatLng([simSimulatedPosition.lat, simSimulatedPosition.lng])
    }
}

function simUpdateAll() {
    simUpdateCurrentOrders()
    simCreateDriverMarker()
    simDrawRoute()

    if (simSimulatedPosition) {
        simSetPositionText(simSimulatedPosition.lat, simSimulatedPosition.lng)
    }
}

async function simLoadRoute() {
    try {
        const response = await fetch('/orders')
        if (!response.ok) {
            simLog('Kunne ikke laste ordredata')
            return
        }

        const allOrders = await response.json()
        simOrders = allOrders
        simUpdateCurrentOrders()

        const firstRouteOrder = simGetOptimizedOrders(simOrders)[0] || null
        if (firstRouteOrder && !simSimulatedPosition) {
            simSimulatedPosition = {
                lat: Number(firstRouteOrder.lat) - 0.01,
                lng: Number(firstRouteOrder.lng) - 0.01
            }
        }

        simUpdateAll()
        simLog('Rute lastet')
    } catch (error) {
        console.error(error)
        simLog('Feil ved lasting av rute')
    }
}

function simFocusMap() {
    simDrawRoute()
    simLog('Kart fokusert')
}

function simMoveToNext() {
    if (!simCurrentNextOrder) {
        simLog('Ingen neste stopp å flytte til')
        return
    }

    simSimulatedPosition = {
        lat: Number(simCurrentNextOrder.lat),
        lng: Number(simCurrentNextOrder.lng)
    }

    simUpdateAll()
    simLog(`Flyttet til neste stopp: ${simCurrentNextOrder.address || 'Ukjent'}`)
}

function simArrive() {
    if (!simCurrentNextOrder) {
        simLog('Ingen neste stopp å simulere ankomst for')
        return
    }

    simSimulatedPosition = {
        lat: Number(simCurrentNextOrder.lat) + 0.0003,
        lng: Number(simCurrentNextOrder.lng) + 0.0003
    }

    simUpdateAll()
    simSetStatus(`Simulert ankomst ved: ${simCurrentNextOrder.address || 'Ukjent'}`)
    simLog('Ankomst simulert')
}

async function simStartJob() {
    if (!simCurrentNextOrder) {
        simLog('Ingen jobb klar for start')
        return
    }

    const response = await fetch(`/orders/${simCurrentNextOrder.id}/start`, { method: 'PATCH' })
    if (!response.ok) {
        simLog('Kunne ikke starte jobb')
        return
    }

    simLog(`Startet jobb: ${simCurrentNextOrder.address || 'Ukjent'}`)
    await simLoadRoute()
}

async function simCompleteJob() {
    if (!simCurrentActiveOrder) {
        simLog('Ingen aktiv jobb å fullføre')
        return
    }

    const response = await fetch(`/orders/${simCurrentActiveOrder.id}/complete`, { method: 'PATCH' })
    if (!response.ok) {
        simLog('Kunne ikke fullføre jobb')
        return
    }

    simLog(`Fullførte jobb: ${simCurrentActiveOrder.address || 'Ukjent'}`)
    await simLoadRoute()
}

function simSetupEvents() {
    const loadBtn = document.getElementById('sim-load-route')
    const focusBtn = document.getElementById('sim-focus')
    const moveNextBtn = document.getElementById('sim-move-next')
    const arriveBtn = document.getElementById('sim-arrive')
    const startBtn = document.getElementById('sim-start-job')
    const completeBtn = document.getElementById('sim-complete-job')

    if (loadBtn) loadBtn.addEventListener('click', simLoadRoute)
    if (focusBtn) focusBtn.addEventListener('click', simFocusMap)
    if (moveNextBtn) moveNextBtn.addEventListener('click', simMoveToNext)
    if (arriveBtn) arriveBtn.addEventListener('click', simArrive)
    if (startBtn) startBtn.addEventListener('click', simStartJob)
    if (completeBtn) completeBtn.addEventListener('click', simCompleteJob)
}

document.addEventListener('DOMContentLoaded', () => {
    simEnsureMap()
    simSetupEvents()
    simLoadRoute()
})
