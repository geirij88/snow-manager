let map = null
let driverMarker = null
let routeMarkers = []
let pendingMarkers = []
let currentRouteLine = null
let currentRouteRequestId = 0
let currentTodayOrders = []
let lastTodayOrderIds = []
let currentActiveOrder = null
let currentNextOrder = null
let navigationTargetOrder = null
let mowingStartTime = null
let arrivedAtCustomer = false
let lastRouteSignature = ''
let latestIncomingTodayOrder = null
let highlightedPendingMarker = null
let actionableIncomingOrders = []
let manualReviewOrders = []
let manualAddressSuggestTimer = null
let manualAddressDraft = ''
let manualSelectedSuggestion = null
let latestDriverPosition = null
let currentLockedBounds = null
let gpsStatusText = 'GPS: venter på posisjon'

function createDriverIcon(heading = 0) {
    const safeHeading = Number.isFinite(heading) ? heading : 0

    return L.divIcon({
        className: 'driver-direction-icon-wrapper',
        html: `
            <div style="
                width: 38px;
                height: 38px;
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
            ">
                <div style="
                    position: absolute;
                    width: 22px;
                    height: 22px;
                    border-radius: 999px;
                    background: #2563eb;
                    border: 3px solid #ffffff;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.45);
                "></div>
                <div style="
                    position: absolute;
                    width: 0;
                    height: 0;
                    border-left: 8px solid transparent;
                    border-right: 8px solid transparent;
                    border-bottom: 14px solid #ffffff;
                    transform: translateY(-14px) rotate(${safeHeading}deg);
                    transform-origin: center 20px;
                    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));
                "></div>
            </div>
        `,
        iconSize: [38, 38],
        iconAnchor: [19, 19]
    })
}

function initMap() {
    if (map) return

    map = L.map('map').setView([59.1248, 11.3875], 12) // Halden default

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map)
}

function clearRouteMarkers() {
    routeMarkers.forEach(m => map.removeLayer(m))
    routeMarkers = []
}

function clearPendingMarkers() {
    pendingMarkers.forEach(marker => {
        if (map) map.removeLayer(marker)
    })
    pendingMarkers = []
}

function clearHighlightedPendingMarker() {
    if (highlightedPendingMarker && map) {
        map.removeLayer(highlightedPendingMarker)
    }
    highlightedPendingMarker = null
}

function createPendingPinIcon() {
    return L.divIcon({
        className: 'driver-pending-pin-wrapper',
        html: `
            <div style="position: relative; width: 26px; height: 36px; display: flex; align-items: flex-start; justify-content: center;">
                <div style="
                    position: absolute;
                    top: 0;
                    left: 50%;
                    transform: translateX(-50%);
                    width: 24px;
                    height: 24px;
                    border-radius: 999px;
                    background: #dc3545;
                    color: #ffffff;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 13px;
                    font-weight: 800;
                    border: 2px solid #ffffff;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.35);
                ">P</div>
                <div style="
                    position: absolute;
                    top: 20px;
                    left: 50%;
                    transform: translateX(-50%);
                    width: 0;
                    height: 0;
                    border-left: 8px solid transparent;
                    border-right: 8px solid transparent;
                    border-top: 13px solid #dc3545;
                    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.25));
                "></div>
            </div>
        `,
        iconSize: [26, 36],
        iconAnchor: [13, 34],
        popupAnchor: [0, -30]
    })
}


function clearCurrentRouteLine() {
    if (currentRouteLine && map) {
        map.removeLayer(currentRouteLine)
    }
    currentRouteLine = null
}

function buildRouteSignature(routeCoords) {
    return routeCoords
        .map(coord => `${Number(coord[0]).toFixed(6)},${Number(coord[1]).toFixed(6)}`)
        .join('|')
}

function drawFallbackRouteLine(routeCoords) {
    if (!map || routeCoords.length < 2) return

    clearCurrentRouteLine()

    currentRouteLine = L.polyline(routeCoords, {
        color: '#2e7dff',
        weight: 4,
        opacity: 0.85
    }).addTo(map)
}

async function drawRoadRouteLine(routeCoords) {
    if (!map || routeCoords.length < 2) return

    const requestId = ++currentRouteRequestId
    const coordinates = routeCoords.map(coord => `${coord[1]},${coord[0]}`).join(';')
    const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`

    try {
        const response = await fetch(url)
        if (!response.ok) {
            if (!currentRouteLine) {
                drawFallbackRouteLine(routeCoords)
            }
            return
        }

        const data = await response.json()
        const route = data.routes && data.routes[0]

        if (!route || !route.geometry || !route.geometry.coordinates || requestId !== currentRouteRequestId) {
            if (!currentRouteLine) {
                drawFallbackRouteLine(routeCoords)
            }
            return
        }

        const latLngs = route.geometry.coordinates.map(coord => [coord[1], coord[0]])

        clearCurrentRouteLine()
        currentRouteLine = L.polyline(latLngs, {
            color: '#ef4444',
            weight: 6,
            opacity: 0.9
        }).addTo(map)
    } catch (error) {
        if (!currentRouteLine) {
            drawFallbackRouteLine(routeCoords)
        }
    }
}


function focusOnDriverAndTarget() {
    if (!map || !driverMarker || !navigationTargetOrder || !navigationTargetOrder.lat || !navigationTargetOrder.lng) return

    const driverPos = driverMarker.getLatLng()
    const bounds = L.latLngBounds([
        [driverPos.lat, driverPos.lng],
        [Number(navigationTargetOrder.lat), Number(navigationTargetOrder.lng)]
    ])

    if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [80, 80] })
    }
}

function lockMapToBounds(bounds, padding = [40, 40]) {
    if (!map || !bounds || !bounds.isValid()) return

    const paddedBounds = bounds.pad(0.15)
    currentLockedBounds = paddedBounds

    map.fitBounds(bounds, { padding })
    map.setMaxBounds(paddedBounds)

    const currentZoom = map.getZoom()
    if (Number.isFinite(currentZoom)) {
        map.setMinZoom(currentZoom)
    }
}

function drawRouteMarkers(orders) {
    if (!map) return

    // Navigation mode: show only driver and current navigation target
    if (navigationTargetOrder && driverMarker && navigationTargetOrder.lat && navigationTargetOrder.lng) {

        clearRouteMarkers()
        clearPendingMarkers()
        clearHighlightedPendingMarker()

        const optimized = getOptimizedRouteOrders(orders)
        const targetId = navigationTargetOrder.id

        optimized.forEach((order, index) => {
            if (!order.lat || !order.lng) return

            const lat = Number(order.lat)
            const lng = Number(order.lng)
            const isTarget = order.id === targetId

            const marker = L.circleMarker([lat, lng], {
                radius: isTarget ? 12 : 8,
                fillColor: isTarget ? '#ef4444' : '#64748b',
                color: '#ffffff',
                weight: isTarget ? 2 : 1,
                opacity: 1,
                fillOpacity: isTarget ? 0.95 : 0.45,
            }).addTo(map)

            marker.bindTooltip(`${index + 1}`, {
                permanent: true,
                direction: 'center',
                className: 'driver-route-number-tooltip'
            })

            routeMarkers.push(marker)
        })

        const driverPos = driverMarker.getLatLng()
        const targetLat = Number(navigationTargetOrder.lat)
        const targetLng = Number(navigationTargetOrder.lng)

        const dimCoords = optimized
            .filter(order => order.lat && order.lng)
            .map(order => [Number(order.lat), Number(order.lng)])

        clearCurrentRouteLine()

        if (dimCoords.length > 1) {
            currentRouteLine = L.polyline(dimCoords, {
                color: '#64748b',
                weight: 4,
                opacity: 0.28
            }).addTo(map)
        }

        drawRoadRouteLine([
            [driverPos.lat, driverPos.lng],
            [targetLat, targetLng]
        ])

        focusOnDriverAndTarget()
        return
    }

    clearRouteMarkers()
    clearPendingMarkers()
    clearHighlightedPendingMarker()

    const optimized = getOptimizedRouteOrders(orders)
    const routeCoords = []
    const boundsPoints = []

    optimized.forEach((order, index) => {
        if (!order.lat || !order.lng) return

        const lat = Number(order.lat)
        const lng = Number(order.lng)
        routeCoords.push([lat, lng])
        boundsPoints.push([lat, lng])

        const marker = L.circleMarker([lat, lng], {
            radius: 10,
            fillColor: order.status === 'active' ? '#2e8b57' : '#2e7dff',
            color: '#ffffff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.95,
        }).addTo(map)

        marker.bindTooltip(`${index + 1}`, {
            permanent: true,
            direction: 'center',
            className: 'driver-route-number-tooltip'
        })

        marker.bindPopup(`
            <b>#${index + 1} ${order.address || ''}</b><br>
            ${order.customer_name || ''}
        `)

        routeMarkers.push(marker)
    })

    const pendingOrders = orders.filter(order =>
        order.status === 'pending' && order.lat && order.lng
    )

    pendingOrders.forEach(order => {
        const lat = Number(order.lat)
        const lng = Number(order.lng)
        boundsPoints.push([lat, lng])

        const marker = L.marker([lat, lng], {
            icon: createPendingPinIcon(),
            zIndexOffset: 1200,
        }).addTo(map)

        marker.bindPopup(`
            <b>Pending ${order.address || ''}</b><br>
            ${order.customer_name || ''}
        `)

        pendingMarkers.push(marker)
    })

    if (driverMarker) {
        const driverLatLng = driverMarker.getLatLng()
        boundsPoints.push([driverLatLng.lat, driverLatLng.lng])
    }

    const newRouteSignature = buildRouteSignature(routeCoords)
    const routeChanged = newRouteSignature !== lastRouteSignature

    if (routeCoords.length > 1 && routeChanged) {
        lastRouteSignature = newRouteSignature
        drawRoadRouteLine(routeCoords).then(() => {
            pendingMarkers.forEach(marker => {
                if (marker.bringToFront) marker.bringToFront()
            })
            if (highlightedPendingMarker && highlightedPendingMarker.bringToFront) {
                highlightedPendingMarker.bringToFront()
            }
        })
    }

    if (routeCoords.length < 2) {
        lastRouteSignature = newRouteSignature
        clearCurrentRouteLine()
    }

    if (latestIncomingTodayOrder && latestIncomingTodayOrder.status === 'pending' && latestIncomingTodayOrder.lat && latestIncomingTodayOrder.lng) {
        const highlightLat = Number(latestIncomingTodayOrder.lat)
        const highlightLng = Number(latestIncomingTodayOrder.lng)

        highlightedPendingMarker = L.circleMarker([highlightLat, highlightLng], {
            radius: 19,
            color: '#dc3545',
            weight: 3,
            opacity: 0.9,
            fillOpacity: 0
        }).addTo(map)

        if (highlightedPendingMarker.bringToFront) highlightedPendingMarker.bringToFront()
    }

    if (navigationTargetOrder && driverMarker && navigationTargetOrder.lat && navigationTargetOrder.lng) {
        focusOnDriverAndTarget()
        return
    }

    if (boundsPoints.length > 0) {
        const bounds = L.latLngBounds(boundsPoints)
        if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [40, 40] })
        }
    }
}

function startGPS() {
    if (!navigator.geolocation) {
        updateGpsStatus('GPS: geolocation støttes ikke')
        return
    }

    updateGpsStatus('GPS: geolocation støttes, venter på signal')

    navigator.geolocation.watchPosition(pos => {
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        const heading = Number.isFinite(pos.coords.heading) ? pos.coords.heading : 0
        const speed = Number.isFinite(pos.coords.speed) ? pos.coords.speed : null

        latestDriverPosition = { lat, lng, heading, speed }
        updateGpsStatus(`GPS: OK ${lat.toFixed(5)}, ${lng.toFixed(5)}`)

        if (!map) return

        if (!driverMarker) {
            driverMarker = L.marker([lat, lng], {
                icon: createDriverIcon(heading),
                zIndexOffset: 2500
            }).addTo(map)
            driverMarker.bindPopup("Din posisjon")
        } else {
            driverMarker.setLatLng([lat, lng])
            driverMarker.setIcon(createDriverIcon(heading))
        }

        if (driverMarker.bringToFront) {
            driverMarker.bringToFront()
        }

        drawRouteMarkers(currentTodayOrders)

        if (navigationTargetOrder && !arrivedAtCustomer && navigationTargetOrder.lat && navigationTargetOrder.lng) {
            const dist = distanceBetweenLatLng(
                lat,
                lng,
                Number(navigationTargetOrder.lat),
                Number(navigationTargetOrder.lng)
            )

            if (dist < 100) {
                arrivedAtCustomer = true

                const startBtn = document.getElementById('start-btn')
                if (startBtn && !currentActiveOrder) {
                    startBtn.innerText = 'Start måking'
                }
            }
        }
        updateProgress()
    }, err => {
        console.warn('GPS feil', err)
        const errorMessage = err && err.message ? err.message : 'ukjent feil'
        updateGpsStatus(`GPS-feil: ${errorMessage}`)
    }, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000
    })
}

function formatAddress(order) {
    return [order.address, order.postal_code, order.city].filter(Boolean).join(', ')
}

function isToday(order) {
    if (!order || !order.job_date) return false
    const dateValue = String(order.job_date).slice(0, 10)
    const today = new Date()
    const todayKey = today.toISOString().slice(0, 10)
    return dateValue === todayKey
}

function getTodayRelevantOrders(orders) {
    return orders.filter(order =>
        isToday(order) && ['pending', 'accepted', 'routed', 'active'].includes(order.status)
    )
}

function getOptimizedRouteOrders(orders) {
    const routeJobs = orders.filter(order =>
        (order.status === 'routed' || order.status === 'active') && order.lat && order.lng
    )

    if (routeJobs.length <= 1) return routeJobs

    const activeJob = routeJobs.find(order => order.status === 'active')
    const remaining = routeJobs.filter(order => !activeJob || order.id !== activeJob.id)
    const result = []

    let current = activeJob || remaining.shift()
    if (!current) return routeJobs

    result.push(current)

    while (remaining.length > 0) {
        let closestIndex = 0
        let closestDistance = distanceBetweenPoints(current, remaining[0])

        for (let i = 1; i < remaining.length; i += 1) {
            const candidateDistance = distanceBetweenPoints(current, remaining[i])
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

function toRadians(value) {
    return value * (Math.PI / 180)
}

function distanceBetweenPoints(a, b) {
    const lat1 = Number(a.lat)
    const lng1 = Number(a.lng)
    const lat2 = Number(b.lat)
    const lng2 = Number(b.lng)

    const R = 6371
    const dLat = toRadians(lat2 - lat1)
    const dLng = toRadians(lng2 - lng1)

    const aa =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2)

    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa))
    return R * c
}

function distanceBetweenLatLng(lat1, lng1, lat2, lng2) {
    const R = 6371
    const dLat = toRadians(lat2 - lat1)
    const dLng = toRadians(lng2 - lng1)

    const aa =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2)

    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa))
    return R * c * 1000
}

function showAlert(message, order = null) {
    const alertBox = document.getElementById('alert')
    if (!alertBox) return

    latestIncomingTodayOrder = order || null

    if (order && order.lat && order.lng) {
        window.setTimeout(() => {
            drawRouteMarkers(currentTodayOrders)
        }, 50)
    }

    let actionButtons = ''
    if (order) {
        if (order.status === 'pending') {
            actionButtons = `
                <button onclick="acceptIncomingOrder()" style="border:none;border-radius:8px;padding:10px 12px;font-size:14px;font-weight:600;background:#111827;color:#ffffff;cursor:pointer">Godkjenn</button>
            `
        } else if (order.status === 'accepted') {
            actionButtons = `
                <button onclick="routeIncomingOrder()" style="border:none;border-radius:8px;padding:10px 12px;font-size:14px;font-weight:600;background:#111827;color:#ffffff;cursor:pointer">Legg i rute</button>
            `
        }

        actionButtons += `
            <button onclick="dismissIncomingAlert()" style="border:none;border-radius:8px;padding:10px 12px;font-size:14px;font-weight:600;background:#ffffff;color:#111827;cursor:pointer">Lukk</button>
        `
    }

    alertBox.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
            <div>${message}</div>
            ${order ? `<div style="font-size:14px;font-weight:600">${order.address || 'Ukjent adresse'}</div>` : ''}
            ${actionButtons ? `<div style="display:flex;gap:10px;flex-wrap:wrap">${actionButtons}</div>` : ''}
        </div>
    `

    alertBox.style.display = 'block'

    if (!order) {
        window.clearTimeout(showAlert._timer)
        showAlert._timer = window.setTimeout(() => {
            alertBox.style.display = 'none'
        }, 5000)
    }
}

function getActionableIncomingOrders(orders) {
    return orders
        .filter(order => order.status === 'pending' || order.status === 'accepted')
        .sort((a, b) => {
            const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0
            const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0
            return bCreated - aCreated
        })
}

function getManualReviewOrders(orders) {
    return orders
        .filter(order => ['pending', 'accepted'].includes(order.status) && (!order.lat || !order.lng))
        .sort((a, b) => {
            const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0
            const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0
            return bCreated - aCreated
        })
}

function showNextIncomingAlert(preferredOrderId = null) {
    if (!actionableIncomingOrders.length) {
        dismissIncomingAlert(true)
        return
    }

    let nextOrder = null

    if (preferredOrderId != null) {
        nextOrder = actionableIncomingOrders.find(order => order.id === preferredOrderId) || null
    }

    if (!nextOrder) {
        nextOrder = actionableIncomingOrders[0]
    }

    const message = nextOrder.status === 'accepted'
        ? 'Jobb klar til å legges i rute'
        : 'Ny jobb mottatt for i dag'

    showAlert(message, nextOrder)
}

function renderManualAddressSuggestions(items) {
    const box = document.getElementById('manual-address-suggestion-box')
    if (!box) return

    if (!items || !items.length) {
        box.innerHTML = ''
        box.style.display = 'none'
        return
    }

    box.innerHTML = items.map((item, index) => {
        const label = formatManualSuggestionLabel(item).replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `
            <button type="button" data-suggestion-index="${index}" style="width:100%;text-align:left;border:none;background:#ffffff;padding:10px 12px;border-bottom:1px solid #e5e7eb;cursor:pointer;font-size:14px;">
                ${label}
            </button>
        `
    }).join('')

    box.style.display = 'block'

    Array.from(box.querySelectorAll('[data-suggestion-index]')).forEach(button => {
        button.addEventListener('click', () => {
            const picked = items[Number(button.getAttribute('data-suggestion-index'))]
            applyManualAddressSuggestion(picked)
        })
    })
}

function formatManualSuggestionLabel(item) {
    const address = item && item.address ? item.address : {}

    const road = address.road || address.pedestrian || address.footway || address.cycleway || ''
    const houseNumber = address.house_number || ''
    const postcode = address.postcode || ''
    const city = address.city || address.town || address.village || address.hamlet || ''

    const streetPart = [road, houseNumber].filter(Boolean).join(' ')
    const cityPart = [postcode, city].filter(Boolean).join(' ')

    const fallback = String(item && item.display_name ? item.display_name : '').split(',').slice(0, 2).join(', ').trim()

    return [streetPart, cityPart].filter(Boolean).join(', ') || fallback || 'Ukjent adresse'
}

function updateManualLocationConfirmation() {
    const confirmation = document.getElementById('manual-location-confirmation')
    if (!confirmation) return

    if (!manualSelectedSuggestion) {
        confirmation.textContent = ''
        confirmation.style.display = 'none'
        return
    }

    const parts = String(manualSelectedSuggestion.display_name || '').split(',').map(part => part.trim()).filter(Boolean)
    const postcodeMatch = String(manualSelectedSuggestion.display_name || '').match(/\b\d{4}\b/)
    const postcode = postcodeMatch ? postcodeMatch[0] : ''
    let city = ''

    if (postcode) {
        const postcodeIndex = parts.findIndex(part => part.includes(postcode))
        if (postcodeIndex >= 0) {
            city = parts[postcodeIndex].replace(postcode, '').trim()
            if (!city && parts[postcodeIndex + 1]) city = parts[postcodeIndex + 1]
        }
    }

    if (!city && parts.length >= 2) {
        city = parts[1]
    }

    confirmation.textContent = `Bekreftet lokasjon: ${postcode ? postcode + ' ' : ''}${city}`.trim()
    confirmation.style.display = 'block'
}

function applyManualAddressSuggestion(item) {
    manualSelectedSuggestion = item || null

    const input = document.getElementById('manual-address-input')
    const box = document.getElementById('manual-address-suggestion-box')

    if (input && item) {
        input.value = formatManualSuggestionLabel(item)
        manualAddressDraft = input.value
    }

    if (box) {
        box.innerHTML = ''
        box.style.display = 'none'
    }

    updateManualLocationConfirmation()
}

async function fetchManualAddressSuggestions(query) {
    if (!query || query.trim().length < 3) {
        manualSelectedSuggestion = null
        updateManualLocationConfirmation()
        renderManualAddressSuggestions([])
        return
    }

    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=no&q=${encodeURIComponent(query)}`)
        if (!response.ok) {
            renderManualAddressSuggestions([])
            return
        }

        const data = await response.json()
        renderManualAddressSuggestions(Array.isArray(data) ? data : [])
    } catch (error) {
        console.error('Kunne ikke hente adresseforslag', error)
        renderManualAddressSuggestions([])
    }
}

function showManualReviewAlert() {
    const alertBox = document.getElementById('alert')
    if (!alertBox || !manualReviewOrders.length) return

    const order = manualReviewOrders[0]
    latestIncomingTodayOrder = order

    alertBox.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
            <div><strong>Manuell behandling kreves</strong></div>
            <div style="font-size:14px;">Bestillingen for i dag mangler koordinater.</div>

            <div style="font-size:14px;font-weight:600">${order.address || 'Ukjent adresse'}</div>
            <input id="manual-address-input" type="text" placeholder="Skriv riktig adresse..."
                style="padding:8px 10px;border-radius:8px;border:1px solid #d1d5db;font-size:14px;" />
            <div id="manual-location-confirmation" style="display:none;font-size:13px;color:#065f46;background:#d1fae5;padding:8px 10px;border-radius:8px;"></div>
            <div id="manual-address-suggestion-box" style="display:none;border:1px solid #d1d5db;border-radius:8px;overflow:hidden;background:#ffffff;color:#111827;"></div>

            <div style="display:flex;gap:10px;flex-wrap:wrap">
                <button onclick="manualAddToRoute()" style="border:none;border-radius:8px;padding:10px 12px;font-size:14px;font-weight:600;background:#111827;color:#ffffff;cursor:pointer">Legg til i rute</button>

                <button onclick="manualRejectOrder()" style="border:none;border-radius:8px;padding:10px 12px;font-size:14px;font-weight:600;background:#dc3545;color:#ffffff;cursor:pointer">Avvis</button>

                <button onclick="dismissIncomingAlert()" style="border:none;border-radius:8px;padding:10px 12px;font-size:14px;font-weight:600;background:#ffffff;color:#111827;cursor:pointer">Lukk</button>
            </div>
        </div>
    `
    const manualInput = document.getElementById('manual-address-input')
    if (manualInput) {
        manualInput.value = manualAddressDraft || order.address || ''
        manualInput.focus()
        manualInput.addEventListener('input', (event) => {
            window.clearTimeout(manualAddressSuggestTimer)
            const value = event.target.value
            manualAddressDraft = value
            manualSelectedSuggestion = null
            updateManualLocationConfirmation()
            manualAddressSuggestTimer = window.setTimeout(() => {
                fetchManualAddressSuggestions(value)
            }, 250)
        })

        if (manualInput.value.trim().length >= 3) {
            fetchManualAddressSuggestions(manualInput.value)
        }
    }
    alertBox.style.display = 'block'
}

async function manualAddToRoute() {
    if (!latestIncomingTodayOrder) return

    const input = document.getElementById('manual-address-input')
    const address = input ? input.value.trim() : manualAddressDraft.trim()

    if (!address) {
        showAlert('Du må skrive inn en adresse')
        return
    }

    try {
        let picked = manualSelectedSuggestion

        if (!picked) {
            const geo = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=no&q=${encodeURIComponent(address)}`)
            const geoData = await geo.json()

            if (!geoData || !geoData.length) {
                showAlert('Fant ikke adressen')
                return
            }

            picked = geoData[0]
        }

        const lat = picked.lat
        const lng = picked.lon
        const finalAddress = formatManualSuggestionLabel(picked) || address

        const locationResponse = await fetch(`/orders/${latestIncomingTodayOrder.id}/set_location`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng, address: finalAddress })
        })

        if (!locationResponse.ok) {
            showAlert('Kunne ikke lagre lokasjon')
            return
        }

        const routeResponse = await fetch(`/orders/${latestIncomingTodayOrder.id}/route`, { method: 'PATCH' })
        if (!routeResponse.ok) {
            showAlert('Kunne ikke legge i rute')
            return
        }

        manualAddressDraft = ''
        manualSelectedSuggestion = null
        dismissIncomingAlert(true)
        await loadDriverData(false)

    } catch (err) {
        console.error(err)
        showAlert('Kunne ikke oppdatere adressen')
    }
}

async function manualRejectOrder() {
    if (!latestIncomingTodayOrder) return

    manualSelectedSuggestion = null
    const response = await fetch(`/orders/${latestIncomingTodayOrder.id}/cancel`, { method: 'PATCH' })

    if (!response.ok) {
        showAlert('Kunne ikke avvise bestillingen')
        return
    }

    manualAddressDraft = ''
    dismissIncomingAlert(true)
    await loadDriverData(false)
}

function dismissIncomingAlert(forceHide = false) {
    const alertBox = document.getElementById('alert')
    if (!alertBox) return

    if (!forceHide && latestIncomingTodayOrder) {
        actionableIncomingOrders = actionableIncomingOrders.filter(order => order.id !== latestIncomingTodayOrder.id)
        manualReviewOrders = manualReviewOrders.filter(order => order.id !== latestIncomingTodayOrder.id)
    }

    if (forceHide || !manualReviewOrders.length) {
        manualAddressDraft = ''
        manualSelectedSuggestion = null
    }
    latestIncomingTodayOrder = null

    if (!forceHide && actionableIncomingOrders.length > 0) {
        showNextIncomingAlert()
        return
    }

    alertBox.style.display = 'none'
}

async function acceptIncomingOrder() {
    if (!latestIncomingTodayOrder) return

    const acceptResponse = await fetch(`/orders/${latestIncomingTodayOrder.id}/accept`, { method: 'PATCH' })
    if (!acceptResponse.ok) {
        showAlert('Kunne ikke godkjenne ny jobb')
        return
    }

    const routeResponse = await fetch(`/orders/${latestIncomingTodayOrder.id}/route`, { method: 'PATCH' })
    if (!routeResponse.ok) {
        showAlert('Kunne ikke legge ny jobb i rute')
        return
    }

    actionableIncomingOrders = actionableIncomingOrders.filter(order => order.id !== latestIncomingTodayOrder.id)
    dismissIncomingAlert(true)
    await loadDriverData(false)
}

async function routeIncomingOrder() {
    if (!latestIncomingTodayOrder) return

    const response = await fetch(`/orders/${latestIncomingTodayOrder.id}/route`, { method: 'PATCH' })
    if (!response.ok) {
        showAlert('Kunne ikke legge ny jobb i rute')
        return
    }

    actionableIncomingOrders = actionableIncomingOrders.filter(order => order.id !== latestIncomingTodayOrder.id)
    dismissIncomingAlert(true)
    await loadDriverData(false)
}


function setCardContent(containerId, label, order, emptyText) {
    const container = document.getElementById(containerId)
    if (!container) return

    if (!order) {
        container.innerHTML = `
            <div class="label">${label}</div>
            <div class="address">${emptyText}</div>
        `
        return
    }

    container.innerHTML = `
        <div class="label">${label}</div>
        <div class="address">${order.address || 'Ukjent adresse'}</div>
        <div class="customer">${order.customer_name || 'Ukjent kunde'}</div>
        <div class="customer">${formatAddress(order)}</div>
        ${order.phone ? `<div class="customer">📞 ${order.phone}</div>` : ''}
    `
}

function calculateEtcText() {
    const optimized = getOptimizedRouteOrders(currentTodayOrders)
    if (!optimized.length) return '--'

    let remainingRouteOrders = []

    if (currentActiveOrder) {
        const activeIndex = optimized.findIndex(order => order.id === currentActiveOrder.id)
        remainingRouteOrders = activeIndex >= 0 ? optimized.slice(activeIndex) : optimized
    } else {
        remainingRouteOrders = optimized.slice()
    }

    if (!remainingRouteOrders.length) return '--'

    let totalMinutes = remainingRouteOrders.length * 15

    const nextTravelTarget = currentActiveOrder
        ? (currentNextOrder || null)
        : (currentNextOrder || remainingRouteOrders[0] || null)

    if (latestDriverPosition && nextTravelTarget && nextTravelTarget.lat && nextTravelTarget.lng) {
        const distanceKm = distanceBetweenPoints(
            { lat: latestDriverPosition.lat, lng: latestDriverPosition.lng },
            { lat: nextTravelTarget.lat, lng: nextTravelTarget.lng }
        )
        const driveMinutes = (distanceKm / 35) * 60
        totalMinutes += driveMinutes
    }

    const etcDate = new Date(Date.now() + totalMinutes * 60000)
    return etcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function updateProgress() {
    const progressEl = document.getElementById('progress')
    if (!progressEl) return

    const total = currentTodayOrders.filter(order =>
        ['pending', 'accepted', 'routed', 'active', 'completed'].includes(order.status)
    ).length

    const completed = currentTodayOrders.filter(order => order.status === 'completed').length
    const activeIndexBase = completed
    const currentNumber = currentActiveOrder
        ? activeIndexBase + 1
        : (currentNextOrder ? completed + 1 : completed)

    const safeTotal = total > 0 ? total : 0
    const displayNumber = safeTotal > 0 ? Math.min(Math.max(currentNumber, 0), safeTotal) : 0
    const percent = safeTotal > 0 ? Math.round((completed / safeTotal) * 100) : 0
    const etcText = calculateEtcText()

    progressEl.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;justify-content:flex-start;align-items:center;font-size:12px;font-weight:700;color:#ffffff;">
                <span>Jobb ${displayNumber} / ${safeTotal}</span>
            </div>
            <div style="width:100%;height:6px;background:rgba(255,255,255,0.18);border-radius:999px;overflow:hidden;">
                <div style="width:${percent}%;height:100%;background:#22c55e;border-radius:999px;"></div>
            </div>
            <div style="font-size:11px;color:#e5e7eb;line-height:1.2;">
                ETC ${etcText}
            </div>
            <div data-gps-status style="font-size:10px;color:#cbd5e1;line-height:1.2;">
                ${gpsStatusText}
            </div>
        </div>
    `
}

function updateGpsStatus(message) {
    gpsStatusText = message || 'GPS: ukjent status'

    const progressEl = document.getElementById('progress')
    if (!progressEl) return

    const statusEl = progressEl.querySelector('[data-gps-status]')
    if (statusEl) {
        statusEl.textContent = gpsStatusText
    }
}

function updateButtons() {
    const startBtn = document.getElementById('start-btn')
    const finishBtn = document.getElementById('finish-btn')
    const navBtn = document.getElementById('nav-btn')

    if (startBtn) {
        if (navigationTargetOrder && arrivedAtCustomer && !currentActiveOrder) {
            startBtn.disabled = false
            startBtn.style.opacity = '1'
            startBtn.innerText = 'Start måking'
        } else if (navigationTargetOrder && !currentActiveOrder) {
            startBtn.disabled = false
            startBtn.style.opacity = '1'
            startBtn.innerText = 'Navigerer...'
        } else if (currentNextOrder) {
            startBtn.disabled = false
            startBtn.style.opacity = '1'
            startBtn.innerText = 'Start neste jobb'
        } else {
            startBtn.disabled = true
            startBtn.style.opacity = '0.5'
            startBtn.innerText = 'Start neste jobb'
        }
    }

    if (finishBtn) {
        finishBtn.disabled = !currentActiveOrder
        finishBtn.style.opacity = currentActiveOrder ? '1' : '0.5'
    }

    if (navBtn) {
        navBtn.disabled = !currentActiveOrder && !currentNextOrder && !navigationTargetOrder
        navBtn.style.opacity = currentActiveOrder || currentNextOrder || navigationTargetOrder ? '1' : '0.5'
    }
}

function updateDriverView(orders) {
    currentTodayOrders = orders

    drawRouteMarkers(orders)

    currentActiveOrder = orders.find(order => order.status === 'active') || null

    if (currentActiveOrder) {
        navigationTargetOrder = currentActiveOrder
        const optimized = getOptimizedRouteOrders(orders)
        const activeIndex = optimized.findIndex(order => order.id === currentActiveOrder.id)
        currentNextOrder = activeIndex >= 0 ? (optimized[activeIndex + 1] || null) : null
        arrivedAtCustomer = true
    } else {
        const optimized = getOptimizedRouteOrders(orders)
        currentNextOrder = optimized[0] || null

        if (navigationTargetOrder) {
            const stillExists = orders.find(order => order.id === navigationTargetOrder.id)
            if (!stillExists) {
                navigationTargetOrder = null
                arrivedAtCustomer = false
                mowingStartTime = null
            }
        }
    }

    setCardContent('active-job', 'Aktiv jobb', currentActiveOrder, 'Ingen aktiv jobb')
    setCardContent('next-job', 'Neste stopp', currentNextOrder, 'Ingen flere stopp i dag')
    updateButtons()
    updateProgress()
}

async function loadDriverData(showNewJobAlert = true) {
    try {
        const response = await fetch('/orders')
        if (!response.ok) return

        const allOrders = await response.json()
        const todayOrders = getTodayRelevantOrders(allOrders)
        const todayIds = todayOrders.map(order => order.id).sort((a, b) => a - b)

        const previousAlertOrderId = latestIncomingTodayOrder ? latestIncomingTodayOrder.id : null
        const newlyArrivedTodayOrder = showNewJobAlert && lastTodayOrderIds.length > 0
            ? todayOrders.find(order => !lastTodayOrderIds.includes(order.id))
            : null

        actionableIncomingOrders = getActionableIncomingOrders(todayOrders)
        manualReviewOrders = getManualReviewOrders(todayOrders)

        lastTodayOrderIds = todayIds
        updateDriverView(todayOrders)

        if (manualReviewOrders.length > 0) {
            showManualReviewAlert()
        } else if (newlyArrivedTodayOrder) {
            showNextIncomingAlert(newlyArrivedTodayOrder.id)
        } else if (actionableIncomingOrders.length > 0) {
            showNextIncomingAlert(previousAlertOrderId)
        } else {
            dismissIncomingAlert(true)
        }
    } catch (error) {
        console.error('Kunne ikke laste driftdata', error)
    }
}

async function startNextOrder() {
    if (!currentNextOrder) return

    navigationTargetOrder = currentNextOrder
    arrivedAtCustomer = false

    drawRouteMarkers(currentTodayOrders)
    focusOnDriverAndTarget()
    updateButtons()
}

async function startMowing() {
    if (!navigationTargetOrder) return

    const response = await fetch(`/orders/${navigationTargetOrder.id}/start`, { method: 'PATCH' })
    if (!response.ok) {
        showAlert('Kunne ikke starte måking')
        return
    }

    mowingStartTime = Date.now()
    await loadDriverData(false)
}

async function completeMowing() {
    if (!navigationTargetOrder) return

    const response = await fetch(`/orders/${navigationTargetOrder.id}/complete`, { method: 'PATCH' })
    if (!response.ok) {
        showAlert('Kunne ikke fullføre jobb')
        return
    }

    const durationSeconds = mowingStartTime
        ? Math.round((Date.now() - mowingStartTime) / 1000)
        : null

    console.log('Måketid sekunder:', durationSeconds, 'ordre:', navigationTargetOrder.id)

    navigationTargetOrder = null
    mowingStartTime = null
    arrivedAtCustomer = false

    await loadDriverData(false)
}

async function finishActiveOrder() {
    await completeMowing()
}

function navigateToCurrentOrder() {
    const targetOrder = navigationTargetOrder || currentActiveOrder || currentNextOrder
    if (!targetOrder) return

    const query = encodeURIComponent(formatAddress(targetOrder) || targetOrder.address || '')
    window.open(`https://maps.apple.com/?q=${query}`, '_blank')
}

function setupEventListeners() {
    const startBtn = document.getElementById('start-btn')
    const finishBtn = document.getElementById('finish-btn')
    const navBtn = document.getElementById('nav-btn')

    if (startBtn) {
        startBtn.addEventListener('click', () => {
            if (currentActiveOrder && navigationTargetOrder && currentActiveOrder.id === navigationTargetOrder.id) {
                completeMowing()
            } else if (navigationTargetOrder && arrivedAtCustomer) {
                startMowing()
            } else if (navigationTargetOrder) {
                focusOnDriverAndTarget()
            } else {
                startNextOrder()
            }
        })
    }

    if (finishBtn) finishBtn.addEventListener('click', finishActiveOrder)
    if (navBtn) navBtn.addEventListener('click', navigateToCurrentOrder)
}

document.addEventListener('DOMContentLoaded', async () => {
    initMap()
    startGPS()
    setupEventListeners()
    await loadDriverData(false)
    window.setInterval(() => loadDriverData(true), 10000)
})
