let map = null
let markersLayer = null
let addressSearchTimer = null
let lastAddressQuery = ''
let isAddressSearchInFlight = false
let currentOrders = []
let optimizedRouteOrderIds = []
let markerCache = {}
let currentRouteLine = null
let currentRouteRequestId = 0
let lastMapRenderSignature = ''
let lastRouteLineSignature = ''
let collapsibleSectionState = {
    routed: false,
    completed: true,
}

function ensureMap() {
    if (map) return

    const mapElement = document.getElementById('map')
    if (!mapElement) return

    map = L.map('map').setView([59.1248, 11.3875], 12)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
    }).addTo(map)

    markersLayer = L.layerGroup().addTo(map)

    setTimeout(() => {
        map.invalidateSize()
    }, 100)
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

function getOptimizedRouteOrders(orders) {
    const routeJobs = orders.filter(o =>
        (o.status === 'routed' || o.status === 'active') && o.lat && o.lng
    )

    if (routeJobs.length <= 1) return routeJobs

    const activeJob = routeJobs.find(o => o.status === 'active')

    const remaining = routeJobs.filter(o => !activeJob || o.id !== activeJob.id)

    const result = []

    let current = activeJob || remaining.shift()

    result.push(current)

    while (remaining.length > 0) {

        let closestIndex = 0
        let closestDistance = distanceBetweenPoints(current, remaining[0])

        for (let i = 1; i < remaining.length; i++) {

            const d = distanceBetweenPoints(current, remaining[i])

            if (d < closestDistance) {
                closestDistance = d
                closestIndex = i
            }
        }

        current = remaining.splice(closestIndex, 1)[0]

        result.push(current)
    }

    return result
}

function getRouteIndexMap(orders) {

    const optimized = getOptimizedRouteOrders(orders)

    const mapById = {}

    optimized.forEach((o, index) => {
        mapById[o.id] = index
    })

    return mapById
}

function getDisplayedRouteOrders(orders) {
    const routeJobs = orders.filter(o =>
        (o.status === 'routed' || o.status === 'active') && o.lat && o.lng
    )

    if (routeJobs.length <= 1) return routeJobs

    if (optimizedRouteOrderIds.length === 0) {
        return routeJobs
    }

    const idToOrder = {}
    routeJobs.forEach(o => {
        idToOrder[o.id] = o
    })

    const ordered = []

    optimizedRouteOrderIds.forEach(id => {
        if (idToOrder[id]) {
            ordered.push(idToOrder[id])
            delete idToOrder[id]
        }
    })

    Object.values(idToOrder).forEach(o => ordered.push(o))

    return ordered
}

function getDisplayedRouteIndexMap(orders) {
    const displayed = getDisplayedRouteOrders(orders)
    const mapById = {}
    displayed.forEach((o, index) => {
        mapById[o.id] = index
    })
    return mapById
}

function clearCurrentRouteLine() {
    if (currentRouteLine && map) {
        map.removeLayer(currentRouteLine)
    }
    currentRouteLine = null
}

function buildRouteLineSignature(routeCoords) {
    return routeCoords
        .map(coord => `${Number(coord[0]).toFixed(6)},${Number(coord[1]).toFixed(6)}`)
        .join('|')
}

function buildMapRenderSignature(orders) {
    const visible = orders
        .filter(order => order.lat && order.lng && order.status !== 'completed')
        .map(order => [
            order.id,
            order.status,
            Number(order.lat).toFixed(6),
            Number(order.lng).toFixed(6)
        ].join(':'))
        .sort()
        .join('|')

    const routeIds = getDisplayedRouteOrders(orders)
        .map(order => order.id)
        .join(',')

    return `${visible}__${routeIds}`
}

function drawFallbackRouteLine(routeCoords) {
    if (!map || routeCoords.length < 2) return

    clearCurrentRouteLine()

    currentRouteLine = L.polyline(routeCoords, {
        color: '#198754',
        weight: 4,
        opacity: 0.8
    }).addTo(map)
}

async function drawRoadRouteLine(routeCoords) {
    if (!map || routeCoords.length < 2) {
        clearCurrentRouteLine()
        return
    }

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

        if (!route || !route.geometry || !route.geometry.coordinates) {
            if (!currentRouteLine) {
                drawFallbackRouteLine(routeCoords)
            }
            return
        }

        if (requestId !== currentRouteRequestId) {
            return
        }

        const latLngs = route.geometry.coordinates.map(coord => [coord[1], coord[0]])

        clearCurrentRouteLine()
        currentRouteLine = L.polyline(latLngs, {
            color: '#198754',
            weight: 5,
            opacity: 0.85
        }).addTo(map)
    } catch (error) {
        if (!currentRouteLine) {
            drawFallbackRouteLine(routeCoords)
        }
    }
}

function updateMap(orders) {
    ensureMap()
    if (!map || !markersLayer) return

    const mapRenderSignature = buildMapRenderSignature(orders)
    if (mapRenderSignature === lastMapRenderSignature) {
        return
    }
    lastMapRenderSignature = mapRenderSignature

    const routeCoords = []
    const routeJobs = getDisplayedRouteOrders(orders)
    const routeIndexMap = getDisplayedRouteIndexMap(orders)
    const visibleOrders = orders.filter(order => order.lat && order.lng && order.status !== 'completed')
    const visibleIds = new Set(visibleOrders.map(order => order.id))

    Object.keys(markerCache).forEach(id => {
        const numericId = Number(id)
        if (!visibleIds.has(numericId)) {
            markersLayer.removeLayer(markerCache[id])
            delete markerCache[id]
        }
    })

    visibleOrders.forEach(order => {
        let color = '#6c757d'
        if (order.status === 'pending') color = '#dc3545'
        if (order.status === 'accepted') color = '#ffc107'
        if (order.status === 'routed') color = '#0d6efd'
        if (order.status === 'active') color = '#198754'

        const latLng = [Number(order.lat), Number(order.lng)]
        let marker = markerCache[order.id]

        if (!marker) {
            marker = L.circleMarker(latLng, {
                radius: 9,
                fillColor: color,
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.95,
            }).addTo(markersLayer)
            markerCache[order.id] = marker
        } else {
            marker.setLatLng(latLng)
            marker.setStyle({
                radius: 9,
                fillColor: color,
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.95,
            })
        }

        const routeNumber = routeIndexMap[order.id]
        marker.unbindTooltip()
        if (routeNumber !== undefined) {
            marker.bindTooltip(`${routeNumber + 1}`, {
                permanent: true,
                direction: 'top',
                offset: [0, -12],
                className: 'route-number-tooltip'
            })
        }
    })

    routeJobs.forEach(order => {
        routeCoords.push([Number(order.lat), Number(order.lng)])
    })

    if (routeCoords.length > 1) {
        const routeLineSignature = buildRouteLineSignature(routeCoords)
        if (routeLineSignature !== lastRouteLineSignature) {
            lastRouteLineSignature = routeLineSignature
            drawRoadRouteLine(routeCoords)
        }
    } else {
        lastRouteLineSignature = ''
        clearCurrentRouteLine()
    }
}

function clearAddressSuggestions() {
    const box = document.getElementById('address-suggestions')
    if (!box) return
    box.innerHTML = ''
    box.style.display = 'none'
}

function setSelectedCoordinates(lat, lng) {
    const latInput = document.getElementById('selected_lat')
    const lngInput = document.getElementById('selected_lng')
    if (latInput) latInput.value = lat || ''
    if (lngInput) lngInput.value = lng || ''
}

function renderAddressSuggestions(items) {
    const box = document.getElementById('address-suggestions')
    if (!box) return

    box.innerHTML = ''

    if (!items || items.length === 0) {
        box.style.display = 'none'
        return
    }

    items.forEach(item => {
        const div = document.createElement('div')
        div.className = 'suggestion-item'

        const cleanAddress = [item.road, item.house_number].filter(Boolean).join(' ')
        const cleanPlace = [item.postcode, item.city].filter(Boolean).join(' ')
        div.textContent = [cleanAddress, cleanPlace].filter(Boolean).join(', ') || item.display_name || ''

        div.onclick = () => {
            const selectedAddress = [item.road, item.house_number].filter(Boolean).join(' ')
            const addressInput = document.getElementById('address')
            const postalInput = document.getElementById('postal_code')
            const cityInput = document.getElementById('city')

            if (addressInput) addressInput.value = selectedAddress || item.display_name || ''
            if (postalInput) postalInput.value = item.postcode || ''
            if (cityInput) cityInput.value = item.city || ''

            setSelectedCoordinates(item.lat, item.lng)
            lastAddressQuery = ''
            clearAddressSuggestions()
        }

        box.appendChild(div)
    })

    box.style.display = 'block'
}

async function searchAddressSuggestions() {
    const address = document.getElementById('address')?.value.trim() || ''
    const postalCode = document.getElementById('postal_code')?.value.trim() || ''
    const city = document.getElementById('city')?.value.trim() || ''
    const selectedLat = document.getElementById('selected_lat')?.value || ''
    const selectedLng = document.getElementById('selected_lng')?.value || ''

    if (selectedLat && selectedLng) {
        clearAddressSuggestions()
        return
    }

    setSelectedCoordinates('', '')

    if (!address || address.length < 5) {
        lastAddressQuery = ''
        clearAddressSuggestions()
        return
    }

    const queryParts = [address]
    if (postalCode) queryParts.push(postalCode)
    if (city) {
        queryParts.push(city)
    } else {
        queryParts.push('Halden')
    }

    const query = queryParts.filter(Boolean).join(', ')

    if (query === lastAddressQuery || isAddressSearchInFlight) {
        return
    }

    isAddressSearchInFlight = true
    lastAddressQuery = query

    try {
        const response = await fetch(`/address-search?q=${encodeURIComponent(query)}`)

        if (!response.ok) {
            clearAddressSuggestions()
            return
        }

        const result = await response.json()
        renderAddressSuggestions(result)
    } finally {
        isAddressSearchInFlight = false
    }
}

function formatDateForInput(dateValue) {
    if (!dateValue) return ''

    if (typeof dateValue === 'string') {
        const match = dateValue.match(/^\d{4}-\d{2}-\d{2}/)
        if (match) return match[0]
    }

    const d = new Date(dateValue)
    if (Number.isNaN(d.getTime())) return ''
    return d.toISOString().split('T')[0]
}

function updateDashboard(orders) {
    let pending = 0
    let accepted = 0
    let routed = 0
    let active = 0
    let completed = 0

    orders.forEach(o => {
        if (o.status === 'pending') pending++
        if (o.status === 'accepted') accepted++
        if (o.status === 'routed') routed++
        if (o.status === 'active') active++
        if (o.status === 'completed') completed++
    })

    const total = orders.length

    const remainingStops = orders.filter(o =>
        o.status === 'pending' ||
        o.status === 'accepted' ||
        o.status === 'routed' ||
        o.status === 'active'
    ).length

    const minutesPerStop = 15
    const remainingMinutes = remainingStops * minutesPerStop

    const now = new Date()
    const etcDate = new Date(now.getTime() + remainingMinutes * 60000)
    const etcTime = etcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    let dashboard = document.getElementById('dashboard')

    if (!dashboard) {
        const mapContainer = document.getElementById('map')
        if (!mapContainer || !mapContainer.parentNode) return

        dashboard = document.createElement('div')
        dashboard.id = 'dashboard'
        dashboard.style.marginBottom = '12px'
        dashboard.style.width = '100%'

        mapContainer.parentNode.insertBefore(dashboard, mapContainer)
    }

    const card = (dotColor, label, value) => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;min-width:150px;box-shadow:0 2px 8px rgba(0,0,0,0.05)">
            <span style="width:10px;height:10px;border-radius:999px;background:${dotColor};display:inline-block;flex:0 0 auto"></span>
            <div style="display:flex;flex-direction:column;line-height:1.1">
                <span style="font-size:12px;color:#6b7280;font-weight:600">${label}</span>
                <span style="font-size:18px;color:#111827;font-weight:700">${value}</span>
            </div>
        </div>
    `

    dashboard.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:10px;width:100%">
            ${card('#dc3545', 'Pending', pending)}
            ${card('#ffc107', 'Accepted', accepted)}
            ${card('#0d6efd', 'Routed', routed)}
            ${card('#198754', 'Active', active)}
            ${card('#9ca3af', 'Fullført', `${completed}/${total}`)}
            ${card('#111827', 'ETC', etcTime)}
        </div>
    `
}

function renderOrder(order) {
    const div = document.createElement('div')
    div.className = 'order'
    div.style.display = 'flex'
    div.style.justifyContent = 'space-between'
    div.style.alignItems = 'flex-start'
    div.style.gap = '14px'

    const addressLine = [order.address, order.postal_code, order.city].filter(Boolean).join(', ')
    const dateValue = formatDateForInput(order.job_date)
    const clickableDate = `<input type="date" value="${dateValue}" onchange="changeOrderDate(${order.id}, this.value)" style="border:1px solid #e5e7eb;border-radius:8px;padding:4px 6px;font-size:12px;color:#374151;background:#fff;cursor:pointer">`
    const displayedRouteIndexMap = getDisplayedRouteIndexMap(currentOrders.length ? currentOrders : [order])
    const routeIndex = displayedRouteIndexMap[order.id] ?? -1
    const routeBadge = ''
    const buttonStyle = 'style="padding:6px 10px;font-size:12px;line-height:1.1;border-radius:10px;height:32px;min-width:72px"'
    // const secondaryButtonStyle = 'style="padding:6px 10px;font-size:12px;line-height:1.1;border-radius:10px;height:32px;min-width:60px;background:#f3f4f6;color:#374151;border:1px solid #e5e7eb"'
    const deleteButtonStyle = 'style="padding:6px 10px;font-size:12px;line-height:1.1;border-radius:10px;height:32px;min-width:72px"'

    let primaryActionButton = ''

    if (order.status === 'pending') {
        primaryActionButton = `<button class="accept-btn" ${buttonStyle} onclick="acceptOrder(${order.id})">Aksepter</button>`
    }

    if (order.status === 'accepted') {
        primaryActionButton = `<button class="route-btn" ${buttonStyle} onclick="routeOrder(${order.id})">Rute</button>`
    }

    if (order.status === 'routed') {
        primaryActionButton = `<button class="start-btn" ${buttonStyle} onclick="startOrder(${order.id})">Start</button>`
    }

    if (order.status === 'active') {
        primaryActionButton = `<button class="complete-btn" ${buttonStyle} onclick="completeOrder(${order.id})">Ferdig</button>`
    }

    div.innerHTML = `
        <div style="flex:1 1 auto;min-width:0">
            <div class="order-header" style="margin-bottom:8px">
                <div class="order-address">${routeIndex >= 0 ? `#${routeIndex + 1} ` : ''}${order.address || ''}</div>
            </div>
            <div class="order-meta" style="display:flex;flex-direction:column;gap:4px">
                <div>👤 ${order.customer_name || ''}</div>
                <div>📍 ${addressLine}</div>
                ${order.phone ? `<div>📞 ${order.phone}</div>` : ''}
                ${routeBadge}
            </div>
        </div>
        <div style="flex:0 0 280px;display:flex;flex-direction:column;align-items:flex-end;gap:8px">
            <div style="width:100%;display:flex;justify-content:flex-end;align-items:center;gap:8px">
                <span class="status status-${order.status}">${order.status || ''}</span>
                <button onclick="deleteOrder(${order.id})" title="Slett ordre" style="border:none;background:none;cursor:pointer;font-size:16px;color:#dc3545">🗑️</button>
            </div>
            <div style="width:100%;display:flex;justify-content:flex-end">
                ${clickableDate}
            </div>
            <div style="display:grid;grid-template-columns:minmax(72px,1fr);gap:8px;width:100%">
                ${primaryActionButton || '<span></span>'}
            </div>
        </div>
    `

    return div
}

function renderOrderSection(title, orders, accentColor = '#d1d5db', sectionKey = '') {
    const section = document.createElement('div')
    section.style.marginBottom = '18px'

    const header = document.createElement('div')
    header.style.display = 'flex'
    header.style.alignItems = 'center'
    header.style.justifyContent = 'space-between'
    header.style.margin = '0 0 10px 0'
    header.style.padding = '8px 12px'
    header.style.background = '#ffffff'
    header.style.border = '1px solid #e5e7eb'
    header.style.borderLeft = `6px solid ${accentColor}`
    header.style.borderRadius = '10px'

    const isCollapsible = sectionKey === 'completed' || sectionKey.startsWith('routed-')
    const isCollapsed = isCollapsible ? !!collapsibleSectionState[sectionKey] : false
    const toggleIcon = isCollapsible ? (isCollapsed ? '▸' : '▾') : ''

    header.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;color:#111827">
            ${isCollapsible ? `<button onclick="toggleSectionCollapse('${sectionKey}')" style="border:none;background:none;padding:0;margin:0;font-size:14px;font-weight:700;color:#6b7280;cursor:pointer">${toggleIcon}</button>` : ''}
            <span>${title}</span>
        </div>
        <div style="font-size:13px;font-weight:700;color:#6b7280">${orders.length}</div>
    `

    section.appendChild(header)

    if (!isCollapsed) {
        orders.forEach(order => {
            section.appendChild(renderOrder(order))
        })
    }

    return section
}

function toggleSectionCollapse(sectionKey) {
    collapsibleSectionState[sectionKey] = !collapsibleSectionState[sectionKey]
    loadOrders()
}

async function loadOrders() {
    const res = await fetch('/orders')
    const data = await res.json()

    const list = document.getElementById('orders')
    if (!list) return

    const routeIndexMap = getDisplayedRouteIndexMap(data)
    currentOrders = data

    list.innerHTML = ''

    const statusPriority = {
        pending: 0,
        routed: 1,
        active: 1,
        accepted: 2,
        completed: 3
    }

    data.sort((a, b) => {
        const statusDiff = (statusPriority[a.status] || 99) - (statusPriority[b.status] || 99)
        if (statusDiff !== 0) return statusDiff

        if ((a.status === 'routed' || a.status === 'active') && (b.status === 'routed' || b.status === 'active')) {
            const routeDiff = (routeIndexMap[a.id] ?? 999) - (routeIndexMap[b.id] ?? 999)
            if (routeDiff !== 0) return routeDiff
        }

        const dateA = a.job_date ? new Date(a.job_date) : null
        const dateB = b.job_date ? new Date(b.job_date) : null

        if (dateA && dateB) return dateA - dateB
        if (dateA) return -1
        if (dateB) return 1

        return 0
    })

    const pendingOrders = data.filter(order => order.status === 'pending')
    const activeOrders = data.filter(order => order.status === 'active')
    const routedOrders = data.filter(order => order.status === 'routed' || order.status === 'active')
    const acceptedOrders = data.filter(order => order.status === 'accepted')
    const completedOrders = data.filter(order => order.status === 'completed')

    if (pendingOrders.length > 0) {
        list.appendChild(renderOrderSection('Pending – venter godkjenning', pendingOrders, '#dc3545'))
    }

    // Removed separate active section block.

    if (routedOrders.length > 0) {
        const routedGroups = {}
        routedOrders.forEach(order => {
            const dateKey = order.job_date ? order.job_date.split('T')[0] : 'Ingen dato'
            if (!routedGroups[dateKey]) routedGroups[dateKey] = []
            routedGroups[dateKey].push(order)
        })

        const today = new Date()
        const todayKey = today.toISOString().split('T')[0]

        const tomorrow = new Date(today)
        tomorrow.setDate(tomorrow.getDate() + 1)
        const tomorrowKey = tomorrow.toISOString().split('T')[0]

        Object.entries(routedGroups)
            .sort((a, b) => {
                if (a[0] === 'Ingen dato') return 1
                if (b[0] === 'Ingen dato') return -1
                return a[0].localeCompare(b[0])
            })
            .forEach(([dateKey, groupOrders]) => {
                let sectionLabel = 'Rute uten dato'

                if (dateKey === todayKey) {
                    sectionLabel = 'Rute for i dag'
                } else if (dateKey === tomorrowKey) {
                    sectionLabel = 'Rute for i morgen'
                } else if (dateKey !== 'Ingen dato') {
                    const parts = dateKey.split('-')
                    if (parts.length === 3) {
                        sectionLabel = `Rute for ${parts[2]}-${parts[1]}-${parts[0]}`
                    } else {
                        sectionLabel = `Rute for ${dateKey}`
                    }
                }

                const sectionCollapseKey = `routed-${dateKey}`
                if (collapsibleSectionState[sectionCollapseKey] === undefined) {
                    collapsibleSectionState[sectionCollapseKey] = false
                }

                const sectionColor = groupOrders.some(order => order.status === 'active') ? '#198754' : '#0d6efd'
                list.appendChild(renderOrderSection(sectionLabel, groupOrders, sectionColor, sectionCollapseKey))
            })
    }

    if (acceptedOrders.length > 0) {
        list.appendChild(renderOrderSection('Akseptert – ikke lagt i rute', acceptedOrders, '#ffc107'))
    }

    if (completedOrders.length > 0) {
        list.appendChild(renderOrderSection('Fullført', completedOrders, '#9ca3af', 'completed'))
    }

    updateDashboard(data)
    updateMap(data)
}

async function createOrder() {
    const jobDate = document.getElementById('job_date')?.value || ''
    const address = document.getElementById('address')?.value || ''
    const postalCode = document.getElementById('postal_code')?.value || ''
    const city = document.getElementById('city')?.value || ''
    const customer = document.getElementById('customer')?.value || ''
    const phone = document.getElementById('phone')?.value || ''
    const selectedLat = document.getElementById('selected_lat')?.value || ''
    const selectedLng = document.getElementById('selected_lng')?.value || ''

    const response = await fetch(
        `/orders?job_date=${encodeURIComponent(jobDate)}&address=${encodeURIComponent(address)}&postal_code=${encodeURIComponent(postalCode)}&city=${encodeURIComponent(city)}&customer_name=${encodeURIComponent(customer)}&phone=${encodeURIComponent(phone)}&lat=${encodeURIComponent(selectedLat)}&lng=${encodeURIComponent(selectedLng)}`,
        { method: 'POST' }
    )

    if (!response.ok) {
        alert('Kunne ikke legge til jobb')
        return
    }

    if (document.getElementById('address')) document.getElementById('address').value = ''
    if (document.getElementById('postal_code')) document.getElementById('postal_code').value = ''
    if (document.getElementById('city')) document.getElementById('city').value = ''
    if (document.getElementById('customer')) document.getElementById('customer').value = ''
    if (document.getElementById('phone')) document.getElementById('phone').value = ''
    if (document.getElementById('selected_lat')) document.getElementById('selected_lat').value = ''
    if (document.getElementById('selected_lng')) document.getElementById('selected_lng').value = ''

    clearAddressSuggestions()

    loadOrders()
}

async function acceptOrder(orderId) {
    const response = await fetch(`/orders/${orderId}/accept`, { method: 'PATCH' })
    if (!response.ok) {
        alert('Kunne ikke akseptere ordren')
        return
    }
    loadOrders()
}

async function routeOrder(orderId) {
    const response = await fetch(`/orders/${orderId}/route`, { method: 'PATCH' })
    if (!response.ok) {
        alert('Kunne ikke legge jobben i rute')
        return
    }
    loadOrders()
}

async function startOrder(orderId) {
    const response = await fetch(`/orders/${orderId}/start`, { method: 'PATCH' })
    if (!response.ok) {
        alert('Kunne ikke starte jobb')
        return
    }

    const refreshed = await fetch('/orders')
    if (!refreshed.ok) {
        loadOrders()
        return
    }

    const refreshedOrders = await refreshed.json()
    optimizedRouteOrderIds = getOptimizedRouteOrders(refreshedOrders).map(o => o.id)

    loadOrders()
}

async function completeOrder(orderId) {
    const response = await fetch(`/orders/${orderId}/complete`, { method: 'PATCH' })
    if (!response.ok) {
        alert('Kunne ikke fullføre jobb')
        return
    }
    loadOrders()
}

async function deleteOrder(orderId) {
    const confirmed = confirm('Er du sikker på at du vil slette denne ordren?')
    if (!confirmed) return

    const response = await fetch(`/orders/${orderId}`, { method: 'DELETE' })
    if (!response.ok) {
        alert('Kunne ikke slette ordren')
        return
    }
    loadOrders()
}

async function changeOrderDate(orderId, newDate = '') {
    const trimmedDate = (newDate || '').trim()

    const response = await fetch(`/orders/${orderId}/date?job_date=${encodeURIComponent(trimmedDate)}`, { method: 'PATCH' })

    if (!response.ok) {
        alert('Kunne ikke endre dato')
        return
    }

    loadOrders()
}

function navigateToAddress(address) {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`
    window.open(url, '_blank')
}

function optimizeRouteForToday() {
    if (!currentOrders || currentOrders.length === 0) {
        alert('Ingen jobber å optimalisere')
        return
    }

    const routeJobs = currentOrders.filter(o =>
        (o.status === 'routed' || o.status === 'active') && o.lat && o.lng
    )

    if (routeJobs.length < 2) {
        alert('For få rutejobber til å optimalisere')
        return
    }

    optimizedRouteOrderIds = getOptimizedRouteOrders(currentOrders).map(o => o.id)

    loadOrders()
}

document.addEventListener('DOMContentLoaded', () => {
    ensureMap()
    loadOrders()

    const addressInput = document.getElementById('address')
    const postalInput = document.getElementById('postal_code')
    const cityInput = document.getElementById('city')

    if (addressInput) {
        addressInput.addEventListener('input', () => {
            if (addressSearchTimer) clearTimeout(addressSearchTimer)
            addressSearchTimer = setTimeout(searchAddressSuggestions, 800)
        })
    }

    if (postalInput) {
        postalInput.addEventListener('input', () => {
            setSelectedCoordinates('', '')
        })
    }

    if (cityInput) {
        cityInput.addEventListener('input', () => {
            setSelectedCoordinates('', '')
        })
    }

    document.addEventListener('click', (event) => {
        const wrap = document.querySelector('.address-search-wrap')
        if (wrap && !wrap.contains(event.target)) {
            clearAddressSuggestions()
        }
    })
})
