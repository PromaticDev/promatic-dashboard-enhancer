Ext.define('Store.promatic_dashboard_enhancer.Module', {
    extend: 'Ext.Component',
    extensionName: 'promatic_dashboard_enhancer',
    moduleBuild: '2026-08-31-1237',

    // Config runtime — fallback si dist/config.json no carga. loadConfig()
    // pisa estos valores con lo que traiga el JSON (mismo shape). A futuro
    // un backend puede servir el mismo shape y sobrescribir en caliente
    // (ver stub en loadConfig). Cambiar acá = requiere re-publicar; cambiar
    // en config.json = igual requiere re-publicar hoy, pero deja el punto
    // de extensión listo para el override remoto.
    DEFAULT_CONFIG: {
        top5km: { windowDays: 7, activeVehicleCap: 300, source: 'ratings', count: 5 }
    },

    initModule: function () {
        console.log('[promatic_dashboard_enhancer] BUILD ' + this.moduleBuild + ' — initModule: inicio');
        this.config = this.DEFAULT_CONFIG;
        this.loadConfig();
        this.loadStyles();

        var mainPanel = this.buildMainPanel();
        console.log('[promatic_dashboard_enhancer] initModule: mainPanel construido');
        var navTab = this.buildNavTab(mainPanel);

        navTab.map_frame = mainPanel;

        if (window.skeleton && skeleton.navigation && typeof skeleton.navigation.add === 'function') {
            skeleton.navigation.add(navTab);
            console.log('[promatic_dashboard_enhancer] initModule: navTab agregado a skeleton.navigation');
        } else {
            console.log('[promatic_dashboard_enhancer] initModule: skeleton.navigation.add NO disponible todavía');
        }
    },

    buildNavTab: function (mainPanel) {
        var NavTabClass = Ext.ClassManager.get('Pilot.utils.LeftBarPanel') ?
            'Pilot.utils.LeftBarPanel' :
            'Ext.panel.Panel';

        return Ext.create(NavTabClass, {
            title: l('Promatic Dashboard'),
            iconCls: 'fa fa-th-large',
            iconAlign: 'top',
            minimized: true,
            items: [mainPanel]
        });
    },

    // -----------------------------------------------------------------------
    // Layout principal — shell de filas flex (HTML plano vía Ext.DomHelper,
    // sin Ext.container.Container anidado). El sistema de grid CSS de ADR-007
    // (buildLegacyWidgetGrid + wrapWidget + los widgets Ext.panel.Panel) se
    // retiró el 28 ago — ver DEP-003 y BR-PILOT-0006.
    // -----------------------------------------------------------------------

    buildMainPanel: function () {
        this.summaryBar = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-summary',
            html: l('Cargando estado de flota...')
        });

        // RAC primero (27 ago, pedido del usuario) — buildLopShell() queda
        // intacto sin invocar como rollback rápido. LOC será una
        // reorganización de estos mismos widgets vía configuración externa
        // (JSON o consulta a BD) — diseño todavía pendiente, no implementado.
        var me = this;

        // El panel de una extensión se monta lazy: Ext no crea su DOM hasta
        // que el usuario abre el tab. Si lanzamos los widgets acá (al
        // construir), todos los updateCardBody fallan porque las cards
        // todavía no existen. Se arranca todo en 'afterrender' (una vez),
        // que es exactamente "el DOM del panel ya está".
        var panel = Ext.create('Ext.panel.Panel', {
            cls: 'promatic_dashboard_enhancer-panel',
            layout: { type: 'vbox', align: 'stretch' },
            scrollable: 'y',
            items: [this.summaryBar, this.buildRacShell()],
            listeners: {
                afterrender: {
                    single: true,
                    fn: function () {
                        me.bindKmReportLinks(panel);
                        me.bindFleetUpdates();
                        me.loadTop5KmData();
                        me.loadAlertasGenerales();
                        // loadHotspots DESACTIVADO 28 ago: new MapContainer/
                        // setHeatmap afectaba el mapa nativo de PILOT (Online)
                        // en vez de crear uno propio. Nunca verificado en
                        // cuenta real — reactivar tras leer MapContainer.md.
                        me.updateCardBody('hotspots', l('Mapa de desconexión — en integración.'));
                        me.startClock();
                        me.renderLogo();
                    }
                }
            }
        });

        return panel;
    },

    // -----------------------------------------------------------------------
    // Shell vista LOP (26 ago) — solo estructura y placeholders todavía, sin
    // datos ni Highcharts. Filas flex (ver style.css), NO Ext.panel.Panel
    // con layout propio: cada card es un Ext.Component simple con HTML vía
    // Ext.DomHelper, para que Ext no tenga layout de hijos que competir con
    // el CSS. Building block del reemplazo de BR-PILOT-0006 — ver
    // spec/features.md. Reconectar datos widget por widget es el paso
    // siguiente, no parte de este commit.
    // -----------------------------------------------------------------------

    // BR-PILOT-0006 (segunda vuelta, 26 ago): Ext.container.Container con
    // layout 'auto' envuelve cada nivel de hijos en divs propios
    // (outerCt/innerCt, con table-layout:fixed) — confirmado inspeccionando
    // el DOM real en DEMO_CLIENT (brain/files/salida-pilot-v0.5.html). Eso
    // rompe flexbox: el hijo directo de nuestra fila deja de ser la card,
    // pasa a ser el outerCt de Ext. Por eso todo el shell se arma acá como
    // HTML plano (Ext.DomHelper) dentro de UN solo Ext.Component — nada de
    // Ext.container.Container anidado, así el DOM real es exactamente el
    // que escribimos. Actualizar contenido de una card: updateCardBody(id,
    // html), que ubica el nodo por id con Ext.get() — no hay Ext.Component
    // por card, así que no aplica el patrón this.mileageEl.update() del
    // resto del módulo.
    cardMarkup: function (id, opts) {
        opts = opts || {};
        var headCn = [
            { tag: 'h3', cls: 'promatic_dashboard_enhancer-card__title', html: opts.title || '' }
        ];
        if (opts.meta) {
            headCn.push({ tag: 'span', cls: 'promatic_dashboard_enhancer-card__meta', html: opts.meta });
        }
        // (?) con tooltip nativo de Ext (data-qtip) — explica cómo/desde
        // cuándo se lee el dato de la card. QuickTips está activo en el
        // runtime de PILOT.
        if (opts.hint) {
            headCn.push({
                tag: 'span',
                cls: 'promatic_dashboard_enhancer-card__hint',
                'data-qtip': opts.hint,
                title: opts.hint, // fallback si QuickTips no está activo
                html: '?'
            });
        }

        return {
            id: 'promatic_dashboard_enhancer-card-' + id,
            cls: 'promatic_dashboard_enhancer-card' + (opts.grow2 ? ' promatic_dashboard_enhancer-card--grow-2' : ''),
            cn: [
                { cls: 'promatic_dashboard_enhancer-card__head', cn: headCn },
                {
                    id: 'promatic_dashboard_enhancer-card-body-' + id,
                    cls: 'promatic_dashboard_enhancer-card__body',
                    html: opts.bodyHtml || l('Cargando...')
                },
                { cls: 'promatic_dashboard_enhancer-card__footer', cn: [
                    { tag: 'a', href: '#', html: (opts.footerLabel || l('Ver en PILOT')) + ' ›' }
                ] }
            ]
        };
    },

    // Reintento acotado (300ms x 60 = 18s): el shell puede no estar
    // renderizado en el DOM todavía cuando un widget intenta actualizar su
    // card — pasa sobre todo con los que se pintan de una desde
    // buildMainPanel (reloj, logo), antes de que Ext termine de montar el
    // panel y agregarlo a skeleton.navigation. Tope fijo, nunca infinito.
    updateCardBody: function (id, html, attempt) {
        attempt = attempt || 0;
        var el = Ext.get('promatic_dashboard_enhancer-card-body-' + id);
        if (el) {
            el.setHtml(html);
        } else if (attempt < 60) {
            Ext.defer(this.updateCardBody, 300, this, [id, html, attempt + 1]);
        } else {
            console.warn('[promatic_dashboard_enhancer] updateCardBody("' + id +
                '"): la card no apareció en el DOM tras 18s.');
        }
    },

    rowMarkup: function (cardSpecs) {
        return { cls: 'promatic_dashboard_enhancer-row', cn: cardSpecs };
    },

    // Apila 2+ cards en una sola celda de la fila (ver .promatic_dashboard_enhancer-col
    // en style.css) — usado en el shell RAC para que Señal GPS + Alertas
    // Generales compartan el ancho de una columna en vez de tener cada una
    // la suya. Sigue siendo HTML plano vía DomHelper, nada de
    // Ext.container.Container anidado (BR-PILOT-0006).
    colMarkup: function (cardSpecs) {
        return { cls: 'promatic_dashboard_enhancer-col', cn: cardSpecs };
    },

    // -----------------------------------------------------------------------
    // Shell vista RAC (27 ago) — vista activa por defecto ahora ("RAC
    // primero", pedido del usuario). Mismo mecanismo que buildLopShell: HTML
    // plano vía Ext.DomHelper dentro de un único Ext.Component. Reutiliza
    // los ids 'flota'/'top5km'/'hotspots' del shell LOP a propósito — mismo
    // dato exacto, y solo un shell está montado a la vez, así que no hay
    // colisión de ids en el DOM real. Señal GPS se separó de Alertas
    // Generales en 2 widgets (antes 1 solo "Últimas Alertas de Vehículos")
    // porque GPS/desconexión es la única alerta que aparece igual en todo
    // panel sin importar el tipo de negocio del cliente. Fila de 4 columnas
    // planas (no colMarkup — el diseño final de dev/proto-dash.html las puso
    // como 4 pares, no 2+2) — diseño visual portado desde dev/proto-styles.css
    // (27 ago, versión final del usuario) a este CSS con selectores
    // prefijados. gps_signal/alertas_generales quedan en "Cargando..." — su
    // conteo (buckets GPS, events.php por categoría) no está conectado
    // todavía, no se fabrica dato de ejemplo en el plugin real.
    // -----------------------------------------------------------------------
    buildRacShell: function () {
        var rows = [
            this.rowMarkup([
                this.cardMarkup('reloj', { title: l('Hora exacta') }),
                this.cardMarkup('buscador', { title: l('Buscar un reporte…'), grow2: true }),
                this.cardMarkup('logo', { title: 'LOGO' })
            ]),
            this.rowMarkup([
                this.cardMarkup('gps_signal', {
                    title: l('Señal GPS'),
                    hint: l('Vehículos sin conexión al servidor, agrupados por el tiempo desde su última señal recibida. Se actualiza en vivo con el árbol Online.'),
                    footerLabel: l('Abrir alertas de señal')
                }),
                this.cardMarkup('alertas_generales', {
                    title: l('Alertas Generales'),
                    hint: l('Accidentes: eventos de los últimos 30 días. Requiere mantención: recordatorios por vehículo configurados en PILOT.'),
                    footerLabel: l('Abrir alertas')
                }),
                this.cardMarkup('flota', {
                    title: l('Estado de Flota'),
                    hint: l('Porcentajes sobre el total de vehículos del árbol Online. Se actualiza en vivo.'),
                    footerLabel: l('Abrir árbol de flota')
                }),
                this.cardMarkup('top5km', {
                    title: l('Vehículos con más KM'),
                    hint: l('Kilómetros por vehículo en el período configurado (por defecto 7 días). Fuente: panel de analítica de PILOT, con respaldo al reporte de kilometraje.'),
                    footerLabel: l('Abrir reporte de kilometraje')
                })
            ]),
            this.rowMarkup([
                this.cardMarkup('hotspots', {
                    title: l('Hotspots de desconexión'), meta: 'type=15',
                    footerLabel: l('Abrir mapa de desconexión')
                })
            ])
        ];

        return Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-rac-shell',
            html: Ext.DomHelper.markup(rows)
        });
    },

    buildLopShell: function () {
        var rows = [
            this.rowMarkup([
                this.cardMarkup('reloj', { title: l('Hora exacta') }),
                this.cardMarkup('buscador', { title: l('Buscar un reporte…'), grow2: true }),
                this.cardMarkup('logo', { title: 'LOGO' })
            ]),
            this.rowMarkup([
                this.cardMarkup('alertas', {
                    title: l('Últimas Alertas'), meta: 'events.php + ptm',
                    footerLabel: l('Abrir alertas')
                }),
                this.cardMarkup('velocidad_lop', {
                    title: l('Velocidad de conducción'), meta: 'speeding_pie.php',
                    footerLabel: l('Abrir reporte de velocidad')
                }),
                this.cardMarkup('ralenti', {
                    title: l('Ralentí'), meta: 'type=16',
                    footerLabel: l('Abrir reporte de ralentí')
                })
            ]),
            this.rowMarkup([
                this.cardMarkup('flota', {
                    title: l('Flota'), meta: 'online_tree.status',
                    footerLabel: l('Abrir árbol de flota')
                }),
                this.cardMarkup('top5km', {
                    title: l('Vehículos con más KM'), meta: 'rt=4',
                    footerLabel: l('Abrir reporte de kilometraje')
                })
            ]),
            this.rowMarkup([
                this.cardMarkup('hotspots', {
                    title: l('Hotspots de desconexión'), meta: 'type=15',
                    footerLabel: l('Abrir mapa de desconexión')
                }),
                this.cardMarkup('disponibles', {
                    title: l('Disponibles/ubicación'),
                    footerLabel: l('Abrir mapa de disponibilidad')
                })
            ])
        ];

        return Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-lop-shell',
            html: Ext.DomHelper.markup(rows)
        });
    },

    // Diccionario de errores (catálogo completo en spec/datos.md): cada
    // punto de falla conocido de un widget emite un código corto y estable
    // (ej. "KM-TIMEOUT") — permite que el usuario reporte "vi el código X"
    // sin necesitar abrir la consola del navegador. Sin backend de logging
    // por ahora, solo trazabilidad local.
    widgetErrorCode: function (base, err, context) {
        var code = base + (err && err.name === 'AbortError' ? '-TIMEOUT' : '-FALLO');
        console.error('[promatic_dashboard_enhancer] ' + code + ':', err, context || '');
        return code;
    },

    getOnlineTree: function () {
        return (window.skeleton && skeleton.navigation && skeleton.navigation.online &&
            skeleton.navigation.online.online_tree) || null;
    },

    // Filtro opcional de alcance de flota — resuelve cuentas donde
    // online_tree expone muchos más vehículos de los que un widget necesita
    // consultar de una vez (ver spec/datos.md, "Filtro de alcance de
    // flota"). Configurado vía localStorage, NUNCA hardcodeado acá: este
    // archivo se sincroniza al repo público (dist/), y una lista de
    // agent_ids de un cliente real es dato operativo de cuenta, no código.
    // Ausente/vacío = sin filtro (comportamiento actual, sin cambios).
    FLEET_SCOPE_STORAGE_KEY: 'promatic_dashboard_enhancer_fleet_scope',

    getFleetScopeFilter: function () {
        try {
            var raw = window.localStorage && localStorage.getItem(this.FLEET_SCOPE_STORAGE_KEY);
            var ids = raw ? JSON.parse(raw) : null;
            return (Array.isArray(ids) && ids.length) ? ids : null;
        } catch (err) {
            this.widgetErrorCode('FLEET-SCOPE', err);
            return null;
        }
    },

    getScopedFleetRecords: function (onlineTree) {
        var records = onlineTree.getStore().getData().items;
        var scope = this.getFleetScopeFilter();
        if (!scope) {
            return records;
        }

        var scopeSet = {};
        for (var i = 0; i < scope.length; i++) {
            scopeSet[scope[i]] = true;
        }

        var filtered = [];
        for (var j = 0; j < records.length; j++) {
            var agentid = records[j].get('agentid');
            if (agentid && scopeSet[agentid]) {
                filtered.push(records[j]);
            }
        }

        // El filtro no matcheó ningún vehículo del árbol Online actual —
        // casi seguro config stale de otra cuenta/sesión (los 45 ids del
        // demo del 26 ago ya no aplican). Se ignora y se usa la flota
        // completa: mejor mostrar de más que un dashboard en 0.
        if (filtered.length === 0 && records.length > 0) {
            if (!this._scopeMismatchLogged) {
                this._scopeMismatchLogged = true;
                console.warn('[promatic_dashboard_enhancer] filtro de alcance de flota (localStorage "' +
                    this.FLEET_SCOPE_STORAGE_KEY + '") no coincide con ningún vehículo del árbol Online — ' +
                    'se ignora, se usa la flota completa. Para limpiarlo: localStorage.removeItem("' +
                    this.FLEET_SCOPE_STORAGE_KEY + '").');
            }
            return records;
        }

        return filtered;
    },

    getFleetVehicleIds: function (onlineTree) {
        var records = this.getScopedFleetRecords(onlineTree);
        var vehIds = [];
        for (var i = 0; i < records.length; i++) {
            var agentid = records[i].get('agentid');
            if (agentid) {
                vehIds.push(agentid);
            }
        }
        return vehIds;
    },

    // Vehículos del alcance que se movieron en los últimos `days` días —
    // filtro por `last_event.last_move` (timestamp del último movimiento),
    // client-side, sin llamada. Un vehículo sin movimiento en la ventana
    // tiene 0 km, así que dejarlo fuera de la consulta a reports.php no
    // cambia el ranking pero corta el payload (crítico cuando online_tree
    // tiene la flota LOC completa — ver NOC-007 y la exploración del 28 ago:
    // no hay endpoint de km por vehículo pre-calculado).
    // Devuelve los agent_ids ordenados por movimiento más reciente primero,
    // para que el caller pueda cortar a un tope (config top5km.activeVehicleCap)
    // quedándose con los más activos.
    getRecentlyActiveIds: function (onlineTree, days) {
        var cutoff = Math.floor(Date.now() / 1000) - (days || 7) * 86400;
        var records = this.getScopedFleetRecords(onlineTree);
        var rows = [];
        for (var i = 0; i < records.length; i++) {
            var r = records[i];
            if (!r.get('agentid')) { continue; }
            var le = r.get('last_event') || (r.data && r.data.last_event) || {};
            var moved = Number(le.last_move) || Number(le.unixtimestamp) || 0;
            if (moved >= cutoff) {
                rows.push({ id: r.get('agentid'), moved: moved });
            }
        }
        rows.sort(function (a, b) { return b.moved - a.moved; });
        var ids = [];
        for (var j = 0; j < rows.length; j++) {
            ids.push(rows[j].id);
        }
        return ids;
    },

    // Poll acotado (40 x 500ms = 20s) hasta que el store de online_tree tenga
    // filas, después bindea los listeners UNA sola vez (guard _fleetBound) y
    // hace el primer refresh. NO usa withFleetVehicleIds: su rama de "lista
    // vacía" se re-suscribe a 'datachanged' en cada disparo, y con el árbol
    // Online actualizándose seguido eso se volvía un loop caliente.
    bindFleetUpdates: function (attempt) {
        attempt = attempt || 0;
        var onlineTree = this.getOnlineTree();
        var store = onlineTree && onlineTree.getStore && onlineTree.getStore();
        var count = store && store.getData ? store.getData().items.length : 0;

        if (count === 0) {
            if (attempt < 40) {
                Ext.defer(this.bindFleetUpdates, 500, this, [attempt + 1]);
            } else if (this.summaryBar) {
                this.summaryBar.update(l('No se pudo cargar el árbol de vehículos de PILOT.'));
            }
            return;
        }

        if (!this._fleetBound) {
            store.on('datachanged', this.refreshFleetStore, this);
            store.on('update', this.refreshFleetStore, this);
            this._fleetBound = true;
        }
        this.refreshFleetStore();
    },

    // Segundos desde el último event recibido de un vehículo — proxy de
    // "hace cuánto está sin señal". last_event.unixtimestamp es la marca más
    // reciente que el device mandó (posición/velocidad); para un vehículo
    // is_server_online=false equivale a "cuándo se quedó mudo". Aproximación
    // razonable para buckets de 24h; la fuente exacta por evento de
    // desconexión sería events.php type=15 (llamada HTTP aparte). Devuelve
    // null si no hay timestamp usable.
    secondsSinceLastEvent: function (record) {
        var le = record.get('last_event') || (record.data && record.data.last_event);
        var ts = le && Number(le.unixtimestamp);
        if (!ts || !isFinite(ts)) {
            return null;
        }
        return Math.max(0, Math.floor(Date.now() / 1000) - ts);
    },

    // Único punto que recorre online_tree en cada 'datachanged'/'update' —
    // alimenta la barra de resumen, la card "Flota" (id 'flota') y la card
    // "Señal GPS" (id 'gps_signal') — mismo recorrido, sin llamada HTTP.
    // 'flota'/'gps_signal' son ids compartidos por el shell RAC y el LOP;
    // solo un shell está montado a la vez.
    // Throttle: el árbol Online dispara 'datachanged' cientos de veces por
    // segundo con flota grande (cada ping de cada vehículo). Coalescemos en
    // una corrida cada 2s como mucho — leading edge (la primera pinta al
    // toque) + trailing (una más al final de la ráfaga).
    FLEET_REFRESH_MIN_GAP_MS: 2000,

    refreshFleetStore: function () {
        var me = this;

        if (this._fleetRefreshTimer) {
            return; // ya hay una corrida agendada dentro de la ventana
        }

        var run = function () {
            me._fleetRefreshTimer = null;
            me._fleetRefreshLast = Date.now();
            try {
                me._refreshFleetStore();
            } catch (err) {
                if (!me._fleetRefreshErrLogged) {
                    me._fleetRefreshErrLogged = true;
                    me.widgetErrorCode('FLEET-REFRESH', err);
                }
            }
        };

        var since = this._fleetRefreshLast ? (Date.now() - this._fleetRefreshLast) : Infinity;
        if (since >= this.FLEET_REFRESH_MIN_GAP_MS) {
            run();
        } else {
            this._fleetRefreshTimer = Ext.defer(run, this.FLEET_REFRESH_MIN_GAP_MS - since);
        }
    },

    _refreshFleetStore: function () {
        var onlineTree = this.getOnlineTree();
        if (!onlineTree) {
            return;
        }

        var records = this.getScopedFleetRecords(onlineTree);
        var total = 0;
        var moving = 0, parked = 0, offlineCount = 0;
        var gps24 = 0, gps48 = 0, gpsMore = 0;
        var DAY = 86400;

        for (var i = 0; i < records.length; i++) {
            var r = records[i];

            if (!r.get('agentid')) {
                continue; // nodo de grupo/carpeta, no un vehículo
            }

            var isOnline = !!r.get('is_server_online');
            var statusText = r.get('status') || '';
            total++;

            if (!isOnline) {
                offlineCount++;
                var age = this.secondsSinceLastEvent(r);
                if (age !== null && age < DAY) {
                    gps24++;
                } else if (age !== null && age < 2 * DAY) {
                    gps48++;
                } else {
                    // age >= 48h, o sin timestamp usable — al bucket más
                    // severo (llevamos ≥48h sin saber nada del device).
                    gpsMore++;
                }
            } else if (statusText.indexOf('movimiento') !== -1) {
                // "En movimientos X km/h" vs. "Estacionamiento..." — texto
                // real confirmado en DEMO_CLIENT, no un campo separado.
                moving++;
            } else {
                parked++;
            }
        }

        // Log solo cuando los números cambian — con flota estable, silencio.
        var sig = total + '/' + offlineCount + '/' + moving + '/' + parked +
            '/' + gps24 + '/' + gps48 + '/' + gpsMore;
        if (sig !== this._fleetSig) {
            this._fleetSig = sig;
            console.log('[promatic_dashboard_enhancer] flota: total=' + total +
                ' online=' + (total - offlineCount) + ' offline=' + offlineCount +
                ' | señal GPS <24h=' + gps24 + ' 24-48h=' + gps48 + ' >48h/sin dato=' + gpsMore);
        }

        this.updateSummary(total, total - offlineCount);
        this.updateFlotaLopCard(total, moving, parked, offlineCount);
        this.updateGpsSignalCard(gps24, gps48, gpsMore);
    },

    // Reloj "Hora exacta Chile" — puro cliente, sin API. Se pinta la card una
    // vez y después se actualiza solo el nodo de la hora cada segundo (no
    // updateCardBody, que re-parsea el HTML completo). El setInterval no se
    // limpia: el módulo vive toda la sesión (es un nav tab), igual que el
    // resto del módulo no tiene teardown.
    chileTime: function () {
        try {
            var parts = new Intl.DateTimeFormat('es-CL', {
                timeZone: 'America/Santiago',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
            }).formatToParts(new Date());
            var m = {};
            parts.forEach(function (p) { m[p.type] = p.value; });
            return m.hour + ':' + m.minute + ':' + m.second;
        } catch (err) {
            return Ext.Date.format(new Date(), 'H:i:s');
        }
    },

    startClock: function () {
        var me = this;
        var tick = function () {
            var el = Ext.get('promatic_dashboard_enhancer-clock-time');
            if (el) {
                el.dom.textContent = me.chileTime();
            }
        };

        this.updateCardBody('reloj', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-clock',
            cn: [
                { cls: 'promatic_dashboard_enhancer-clock__label', html: l('Hora exacta Chile') },
                {
                    id: 'promatic_dashboard_enhancer-clock-time',
                    cls: 'promatic_dashboard_enhancer-clock__time',
                    html: me.chileTime()
                }
            ]
        }));

        setInterval(tick, 1000);
    },

    renderLogo: function () {
        this.updateCardBody('logo', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-logo',
            cn: [
                { tag: 'img', src: this.getModuleBaseUrl() + 'img/logo-promatic.png', alt: 'Promatic' }
            ]
        }));
    },

    // Alertas Generales (card 'alertas_generales') — 2 categorías:
    //  - Accidentes: events.php type=29, ventana de 30 días (REF-001 §11.3).
    //  - Requiere mantención: dashboard.php cmd=ptm — recordatorios; contamos
    //    los ligados a vehículo (link_type != 'drivers'). El shape de ptm no
    //    está confirmado en DEMO_CLIENT (en la cuenta de pruebas solo había un
    //    recordatorio de licencia de conductor) — el console.log del raw es
    //    para verificar. Cualquier categoría que falle muestra "N/D", no
    //    tumba la otra.
    // "En taller" se retiró (chip decorativo sin fuente, pedido del Dev de
    // Pilot 25 ago).
    loadAlertasGenerales: function () {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            var csv = vehIds.join(',');
            var stop = new Date();
            var start = new Date();
            start.setDate(start.getDate() - 30);
            var fmt = function (d) { return d.toISOString().slice(0, 10); };

            var accidentes = me.fetchEventCount(csv, 29, fmt(start), fmt(stop))
                .catch(function (err) { me.widgetErrorCode('ALERT-ACC', err); return null; });

            var mantencion = me.fetchDashboardCmd('ptm', csv, 8000)
                .then(function (data) {
                    console.log('[promatic_dashboard_enhancer] ptm raw:', data);
                    var items = (data && (data.data || data.items || data.list)) || [];
                    if (!Array.isArray(items)) { items = []; }
                    var n = 0;
                    for (var i = 0; i < items.length; i++) {
                        if (items[i] && items[i].link_type !== 'drivers') { n++; }
                    }
                    return n;
                })
                .catch(function (err) { me.widgetErrorCode('ALERT-PTM', err); return null; });

            Promise.all([accidentes, mantencion]).then(function (r) {
                console.log('[promatic_dashboard_enhancer] alertas generales: accidentes=' +
                    r[0] + ' requiere_mantencion=' + r[1]);
                me.renderAlertasGenerales(r[0], r[1]);
            });
        });
    },

    renderAlertasGenerales: function (accidentes, mantencion) {
        var svgAccidente =
            '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M9 2 L16.5 15.5 H1.5 Z" /><line x1="9" y1="7" x2="9" y2="11" />' +
            '<circle cx="9" cy="13.2" r="0.9" fill="currentColor" stroke="none" /></svg>';
        var svgMantencion =
            '<svg viewBox="0 0 26 26" fill="currentColor"><path d="M1.313 0L0 1.313l2.313 4l1.5-.22' +
            'l9.156 9.157l-.781.75c-.4.4-.4 1.006 0 1.406l.406.407c.4.4 1.012.4 1.312 0L15.094 18' +
            'c-.1.6 0 1.313.5 1.813L21 25.188c1.1 1.1 2.9 1.1 4 0c1.3-1.2 1.288-2.994.188-4.094' +
            'l-5.375-5.407c-.5-.5-1.213-.7-1.813-.5L16.687 14c.3-.4.3-1.012 0-1.313l-.375-.374' +
            'a.974.974 0 0 0-1.406 0l-.656.656l-9.156-9.156l.218-1.5l-4-2.313zm19.5.031C18.84-.133 ' +
            '16.224 1.175 15 2.312c-1.506 1.506-1.26 3.475-.063 5.376l-2.124 2.125l1.5 1.687c.8-.7 ' +
            '1.98-.7 2.78 0l.407.406l.094.094l.875-.875c1.808 1.063 3.69 1.216 5.125-.219c1.4-1.3 ' +
            '2.918-4.506 2.218-6.406L23 7.406c-.4.4-1.006.4-1.406 0L18.687 4.5a.974.974 0 0 1 0-1.406' +
            'L21.595.188c-.25-.088-.5-.133-.782-.157m-11 12.469l-3.626 3.625A5.3 5.3 0 0 0 5 16' +
            'c-2.8 0-5 2.2-5 5s2.2 5 5 5s5-2.2 5-5c0-.513-.081-1.006-.219-1.469l2.125-2.125l-.312-.406' +
            'c-.8-.8-.794-2.012-.094-2.813L9.812 12.5z" /></svg>';

        var card = function (bg, title, count, iconSvg, titleAttr) {
            return {
                tag: 'a', href: '#', style: 'background:' + bg, title: titleAttr,
                cls: 'promatic_dashboard_enhancer-stat-card',
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat-card__icon', html: iconSvg },
                    { cls: 'promatic_dashboard_enhancer-stat-card__title', html: title },
                    {
                        cls: 'promatic_dashboard_enhancer-stat-card__count',
                        html: (count === null || count === undefined) ? l('N/D') : String(count)
                    }
                ]
            };
        };

        this.updateCardBody('alertas_generales', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-stat-card-grid',
            cn: [
                card('var(--g6)', l('Accidentes'), accidentes, svgAccidente,
                    l('Accidentes — events.php type=29, últimos 30 días')),
                card('var(--g7)', l('Requiere mantención'), mantencion, svgMantencion,
                    l('Recordatorios de mantención de vehículo (ptm)'))
            ]
        }));
    },

    // Hotspots de desconexión (card 'hotspots') — heatmap sobre un
    // MapContainer PROPIO (instancia nueva, NO se reusa window.mapContainer:
    // esa es solo para features dentro de los tabs Online/History — ver
    // spec/api.md "Crear un mapa propio dentro de un panel de la extensión").
    // Datos: events.php type=15 ("No connection"), ventana 30 días, cada item
    // trae lat/lon. Se agrega por celda de ~0.01° y se pasa a setHeatmap.
    getMapContainerClass: function () {
        return window.MapContainer ||
            (window.Pilot && Pilot.utils && Pilot.utils.MapContainer) || null;
    },

    loadHotspots: function () {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            if (!me.getMapContainerClass()) {
                me.updateCardBody('hotspots', l('El mapa no está disponible en este runtime.'));
                return;
            }

            var csv = vehIds.join(',');
            var stop = new Date();
            var start = new Date();
            start.setDate(start.getDate() - 30);
            var fmt = function (d) { return d.toISOString().slice(0, 10); };

            var qs = 'cmd=search&veh=' + encodeURIComponent(csv) +
                '&type=15&date_start=' + fmt(start) + '&date_stop=' + fmt(stop) +
                '&limit=500&page=1&start=0';

            fetch('/backend/ax/mod/events.php?' + qs, { credentials: 'include' })
                .then(function (resp) {
                    if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                    return resp.json();
                })
                .then(function (data) {
                    me.renderHotspots((data && data.items) || []);
                })
                .catch(function (err) {
                    var code = me.widgetErrorCode('HOTSPOTS', err);
                    me.updateCardBody('hotspots',
                        l('No se pudo cargar el mapa de desconexión.') + ' (' + code + ')');
                });
        });
    },

    renderHotspots: function (items) {
        var buckets = {};
        var withCoords = 0;

        for (var i = 0; i < items.length; i++) {
            var lat = Number(items[i].lat);
            var lon = Number(items[i].lon);
            if (!lat || !lon || !isFinite(lat) || !isFinite(lon)) {
                continue; // event sin ubicación
            }
            withCoords++;
            var key = lat.toFixed(2) + ',' + lon.toFixed(2);
            if (!buckets[key]) {
                buckets[key] = { lat: lat, lng: lon, count: 0 };
            }
            buckets[key].count++;
        }

        var points = [];
        for (var k in buckets) {
            if (buckets.hasOwnProperty(k)) {
                points.push(buckets[k]);
            }
        }

        console.log('[promatic_dashboard_enhancer] hotspots: ' + items.length +
            ' eventos type=15, ' + withCoords + ' con coords, ' + points.length + ' celdas');

        if (points.length === 0) {
            this.updateCardBody('hotspots',
                l('Sin desconexiones con ubicación en los últimos 30 días.'));
            return;
        }

        this.updateCardBody('hotspots', Ext.DomHelper.markup({
            id: 'promatic_dashboard_enhancer-hotspots-map',
            cls: 'promatic_dashboard_enhancer-map-el'
        }));

        var me = this;
        var MC = this.getMapContainerClass();

        // defer: el div del mapa tiene que estar en el DOM con dimensiones
        // antes de que Leaflet lo tome (si no, mide 0x0 y no dibuja).
        Ext.defer(function () {
            try {
                var mc = new MC('promatic_dashboard_enhancer_hotspots');
                mc.init(points[0].lat, points[0].lng, 6,
                    'promatic_dashboard_enhancer-hotspots-map', { withControls: true });

                if (typeof mc.setHeatmap === 'function') {
                    mc.setHeatmap(points, true, l('Desconexiones'));
                }
                // Leaflet a veces necesita recalcular tamaño tras montarse
                // dentro de un contenedor flex que terminó de dimensionar.
                Ext.defer(function () {
                    var map = mc.getMap ? mc.getMap() : mc.map;
                    if (map && map.invalidateSize) { map.invalidateSize(); }
                }, 400);

                me._hotspotsMap = mc;
            } catch (err) {
                me.widgetErrorCode('HOTSPOTS-MAP', err);
                me.updateCardBody('hotspots', l('No se pudo inicializar el mapa de desconexión.'));
            }
        }, 300, this);
    },

    updateGpsSignalCard: function (b24, b48, bMore) {
        var row = function (mod, label, count, title) {
            return {
                tag: 'a', href: '#',
                cls: 'promatic_dashboard_enhancer-signal-row promatic_dashboard_enhancer-signal-row--' + mod,
                title: title,
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-signal-row__label', html: label },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-signal-row__badge', html: String(count) }
                ]
            };
        };

        this.updateCardBody('gps_signal', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-signal-card-bg',
            cn: [
                { cls: 'promatic_dashboard_enhancer-signal-card__body', cn: [
                    row('yellow', l('Menos de 24h'), b24, l('Vehículos desconectados hace menos de 24h')),
                    row('orange', l('Entre 24 y 48h'), b48, l('Vehículos desconectados entre 24 y 48h')),
                    row('red', l('Más de 48h'), bMore, l('Vehículos desconectados hace más de 48h o sin dato reciente'))
                ] },
                { tag: 'span', cls: 'promatic_dashboard_enhancer-signal-card-bg__icon', 'aria-hidden': 'true', html:
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
                    '<path stroke-linecap="round" d="m22 8l-3-3m0 0l-3-3m3 3l-3 3m3-3l3-3" />' +
                    '<path d="M9 10.03A3.515 3.515 0 0 1 13.97 15" />' +
                    '<path stroke-linejoin="round" d="M4.853 19.147c3.196 3.196 8.06 3.707 11.789 1.533c.886-.517 1.33-.776 1.357-1.302s-.471-.89-1.468-1.618c-1.848-1.35-3.667-3-5.48-4.812C9.24 11.136 7.59 9.317 6.24 7.47c-.728-.997-1.092-1.495-1.618-1.468s-.785.47-1.302 1.357c-2.174 3.73-1.663 8.593 1.533 11.79Z" />' +
                    '</svg>'
                }
            ]
        }));
    },

    updateFlotaLopCard: function (total, moving, parked, offlineCount) {
        var pct = function (n) {
            return total > 0 ? Math.round((n / total) * 100) : 0;
        };
        var activos = total - offlineCount;

        this.updateCardBody('flota', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-fleet-quadrants',
            cn: [
                { cls: 'promatic_dashboard_enhancer-fleet-quadrant', cn: [
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__pct', html: pct(activos) + '%' },
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__lbl', html: l('Activos') }
                ] },
                { cls: 'promatic_dashboard_enhancer-fleet-quadrant promatic_dashboard_enhancer-fleet-quadrant--moving', cn: [
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__pct', html: pct(moving) + '%' },
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__lbl', html: l('En movimiento') }
                ] },
                { cls: 'promatic_dashboard_enhancer-fleet-quadrant promatic_dashboard_enhancer-fleet-quadrant--parked', cn: [
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__pct', html: pct(parked) + '%' },
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__lbl', html: l('Estacionado') }
                ] },
                { cls: 'promatic_dashboard_enhancer-fleet-quadrant promatic_dashboard_enhancer-fleet-quadrant--offline', cn: [
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__pct', html: pct(offlineCount) + '%' },
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__lbl', html: l('Sin conexión') }
                ] }
            ]
        }));
    },

    updateSummary: function (total, online) {
        if (!this.summaryBar) {
            return;
        }

        var pct = total > 0 ? Math.round((online / total) * 100) : 0;

        this.summaryBar.update(Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-summary__row',
            cn: [
                { cls: 'promatic_dashboard_enhancer-stat', cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: String(total) },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: l('flota') }
                ] },
                { cls: 'promatic_dashboard_enhancer-stat', cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-online' },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: String(online) },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: l('en línea') + ' (' + pct + '%)' }
                ] },
                { cls: 'promatic_dashboard_enhancer-stat', cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-offline' },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: String(total - online) },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: l('desconectados') }
                ] },
                { cls: 'promatic_dashboard_enhancer-summary__updated', html: l('actualizado') + ' ' + Ext.Date.format(new Date(), 'H:i:s') }
            ]
        }));
    },

    // -----------------------------------------------------------------------
    // Fetch compartido — reports.php (get_report / report_type) y analytics/*
    // Todo vía fetch() nativo, nunca Ext.Ajax.request: dentro del proxy
    // /store/<extension>/ de una extensión, Ext.Ajax reescribe rutas
    // relativas y devuelve 404 (confirmado en runtime real, ver spec/api.md).
    // -----------------------------------------------------------------------

    buildReportBody: function (reportType, vehIdsCsv, startDate, stopDate) {
        var pad = function (n) {
            return n < 10 ? '0' + n : '' + n;
        };
        var fmtDate = function (d) {
            return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
        };
        var fmtMonth = function (d) {
            return pad(d.getMonth() + 1) + '.' + d.getFullYear();
        };

        var pairs = [
            ['download', '0'], ['start_time', '00:00'], ['stop_time', '00:00'],
            ['veh_id', vehIdsCsv],
            ['zones_id', ''], ['lines_id', ''], ['stopping_points_id', ''],
            ['drivers_id', ''], ['groups_id', ''], ['holidays', ''],
            ['lang', 'es'], ['explode', '1'],
            ['start_month', fmtMonth(startDate)], ['stop_month', fmtMonth(stopDate)],
            ['pre_start_date', fmtDate(startDate)], ['pre_stop_date', fmtDate(stopDate)],
            ['start_date', fmtDate(startDate) + ' 00:00'], ['stop_date', fmtDate(stopDate) + ' 00:00'],
            ['group', '1'], ['tags[]', ''], ['level[]', ''],
            ['event_group', ''], ['event_groups[]', ''],
            ['map_type', '1'], ['trailer', ''], ['last_ibutton_used', '0'],
            ['report_type', String(reportType)],
            ['vehicle_not_moving_time', '1'], ['vehicles_has_covered_km', '1'],
            ['fillings', 'on'], ['stales', 'on'], ['speed', 'on'], ['rashod', 'on'],
            ['stops', 'on'], ['run', 'on'], ['planned_stops', 'on'], ['unplanned_stops', 'on'],
            ['inside_bus_line', 'on'], ['outside_bus_line', 'on'],
            ['emp_name', ''], ['reason_for_opening', ''], ['report_mc_aid', ''],
            ['trip_types[]', '1'], ['trip_types[]', '2'],
            ['contr_time', '120'], ['limit_count', '0'], ['contr_time_max', '0'],
            ['inspections_report_type', '0'], ['set_months_range', '1'],
            ['type', '1'], ['template', '1']
        ];

        var parts = [];
        for (var i = 0; i < pairs.length; i++) {
            parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
        }
        return parts.join('&');
    },

    fetchReportType: function (reportType, vehIdsCsv, startDate, stopDate, timeoutMs) {
        var body = this.buildReportBody(reportType, vehIdsCsv, startDate, stopDate);
        var ctrl = new AbortController();
        var timeout = setTimeout(function () {
            ctrl.abort();
        }, timeoutMs || 20000);

        return fetch('/backend/ax/reports.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
            signal: ctrl.signal
        }).then(function (resp) {
            if (!resp.ok) {
                throw new Error('HTTP ' + resp.status);
            }
            return resp.json();
        }).finally(function () {
            clearTimeout(timeout);
        });
    },

    // startIso/stopIso opcionales (formato "YYYY-MM-DDTHH:MM:SS"). Sin ellos:
    // día actual con today=true (comportamiento original). Con ellos: ventana
    // real, today='' — necesario para el Top 5 KM (ventana de N días).
    fetchAnalyticsMainData: function (vehIdsCsv, timeoutMs, startIso, stopIso) {
        var isoDay = new Date().toISOString().slice(0, 10) + 'T00:00:00';
        var hasRange = !!(startIso && stopIso);
        var pairs = [
            ['cmd', 'get_main_data'], ['cons_value', 'l/100km'],
            ['ts', hasRange ? startIso : isoDay],
            ['te', hasRange ? stopIso : isoDay],
            ['today', hasRange ? '' : 'true'], ['sync', ''],
            ['agent_ids', vehIdsCsv]
        ];
        var parts = [];
        for (var i = 0; i < pairs.length; i++) {
            parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
        }

        var ctrl = new AbortController();
        var timeout = setTimeout(function () {
            ctrl.abort();
        }, timeoutMs || 8000);

        return fetch('/backend/ax/analytics/vehicles.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: parts.join('&'),
            signal: ctrl.signal
        }).then(function (resp) {
            if (!resp.ok) {
                throw new Error('HTTP ' + resp.status);
            }
            return resp.json();
        }).finally(function () {
            clearTimeout(timeout);
        });
    },

    fetchDashboardCmd: function (cmd, vehIdsCsv, timeoutMs) {
        var isoDay = new Date().toISOString().slice(0, 10) + 'T00:00:00';
        var pairs = [['cmd', cmd], ['agent_ids', vehIdsCsv], ['ts', isoDay], ['te', isoDay]];
        var parts = [];
        for (var i = 0; i < pairs.length; i++) {
            parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
        }

        var ctrl = new AbortController();
        var timeout = setTimeout(function () {
            ctrl.abort();
        }, timeoutMs || 8000);

        return fetch('/backend/ax/analytics/dashboard.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: parts.join('&'),
            signal: ctrl.signal
        }).then(function (resp) {
            if (!resp.ok) {
                throw new Error('HTTP ' + resp.status);
            }
            return resp.json();
        }).finally(function () {
            clearTimeout(timeout);
        });
    },

    fetchEventCount: function (vehIdsCsv, type, dateStart, dateStop) {
        var qs = 'cmd=search&veh=' + encodeURIComponent(vehIdsCsv) +
            '&type=' + encodeURIComponent(type) +
            '&date_start=' + encodeURIComponent(dateStart) +
            '&date_stop=' + encodeURIComponent(dateStop) +
            '&limit=1&page=1&start=0';

        return fetch('/backend/ax/mod/events.php?' + qs, { credentials: 'include' })
            .then(function (resp) {
                if (!resp.ok) {
                    throw new Error('HTTP ' + resp.status);
                }
                return resp.json();
            })
            .then(function (data) {
                return (data && typeof data.total === 'number') ? data.total : 0;
            });
    },

    // Espera (poll acotado, 40 x 500ms = 20s) a que online_tree tenga
    // vehículos y devuelve la lista de agent_ids — patrón compartido por
    // todos los widgets que dependen de la flota. Poll, NO re-suscripción a
    // 'datachanged': el árbol Online se actualiza seguido y re-suscribir en
    // cada disparo se volvía un loop caliente (28 ago).
    withFleetVehicleIds: function (callback, attempt) {
        var me = this;
        attempt = attempt || 0;
        var onlineTree = this.getOnlineTree();
        var vehIds = onlineTree ? this.getFleetVehicleIds(onlineTree) : [];

        if (vehIds.length > 0) {
            callback.call(this, vehIds);
            return;
        }

        if (attempt < 40) {
            Ext.defer(function () { me.withFleetVehicleIds(callback, attempt + 1); }, 500, this);
            return;
        }

        var scope = this.getFleetScopeFilter();
        console.warn('[promatic_dashboard_enhancer] withFleetVehicleIds: 0 vehículos tras 20s. ' +
            (scope ?
                'Filtro de alcance de flota activo con ' + scope.length + ' ids (localStorage "' +
                this.FLEET_SCOPE_STORAGE_KEY + '") — probablemente no coincide con el árbol Online actual. ' +
                'Para limpiarlo: localStorage.removeItem("' + this.FLEET_SCOPE_STORAGE_KEY + '") y recargar.' :
                'Sin filtro de alcance — el árbol Online no cargó vehículos.'));
    },

    // Card "Top 5 · Vehículos con más KM".
    //
    // Fuente primaria: analytics/vehicles.php cmd=get_main_data → ratings.data
    // (km por vehículo en UNA llamada, sin reports.php ni riesgo de timeout —
    // NOC-007). Fallback automático: reports.php report_type=4 (camino previo).
    //
    // En ambos casos se pre-filtra a los vehículos con movimiento reciente
    // (config top5km.windowDays) y se corta a un tope (config
    // top5km.activeVehicleCap) para no disparar el job async + WebSocket de
    // analytics/vehicles.php en flotas grandes (NOC-003). Un vehículo sin
    // movimiento tiene 0 km, así que el filtro no cambia el ranking.
    loadTop5KmData: function () {
        var me = this;
        var cfg = (me.config && me.config.top5km) || me.DEFAULT_CONFIG.top5km;
        var days = cfg.windowDays || 7;
        var cap = cfg.activeVehicleCap || 300;
        var count = cfg.count || 5;

        this.withFleetVehicleIds(function () {
            var onlineTree = me.getOnlineTree();
            var vehIds = me.getRecentlyActiveIds(onlineTree, days);
            var scopeTotal = me.getFleetVehicleIds(onlineTree).length;
            var capped = false;
            if (vehIds.length > cap) {
                vehIds = vehIds.slice(0, cap);
                capped = true;
            }

            console.log('[promatic_dashboard_enhancer] Top KM: ' + vehIds.length +
                ' vehículos con movimiento en ' + days + 'd (de ' + scopeTotal + ' en alcance)' +
                (capped ? ' [cortado al tope de ' + cap + ']' : '') + ' — top ' + count);

            if (vehIds.length === 0) {
                me.updateCardBody('top5km', l('Ningún vehículo con recorrido reciente.'));
                return;
            }

            // Mapa nombre→agentid del árbol Online — la rama fallback
            // (reports.php) agrupa por nombre de vehículo y no trae el id,
            // así se recupera para el link a Informes (best-effort).
            var nameToId = {};
            var records = me.getScopedFleetRecords(onlineTree);
            for (var r = 0; r < records.length; r++) {
                var nm = records[r].get('name');
                if (nm) { nameToId[nm] = records[r].get('agentid'); }
            }

            var stopDate = new Date();
            var startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
            startDate.setHours(0, 0, 0, 0);

            var csv = vehIds.join(',');
            var runReports = function () {
                return me.fetchReportType(4, csv, startDate, stopDate, 20000)
                    .then(function (report) {
                        me.renderTop5Km(me.parseReportType4(report, count, nameToId), days, startDate, stopDate);
                        console.log('[promatic_dashboard_enhancer] Top KM servido por: reports-fallback');
                    });
            };

            if (cfg.source === 'reports') {
                runReports().catch(function (err) {
                    me.reportTop5Error(err, vehIds.length, days);
                });
                return;
            }

            me.fetchAnalyticsMainData(csv, 15000,
                startDate.toISOString().slice(0, 19), stopDate.toISOString().slice(0, 19))
                .then(function (mainData) {
                    me.renderTop5Km(me.parseRatingsTop5(mainData, count), days, startDate, stopDate);
                    console.log('[promatic_dashboard_enhancer] Top KM servido por: ratings');
                })
                .catch(function (err) {
                    console.warn('[promatic_dashboard_enhancer] Top KM: ratings.data no sirvió (' +
                        (err && err.message ? err.message : err) + ') — fallback a reports.php');
                    runReports().catch(function (err2) {
                        me.reportTop5Error(err2, vehIds.length, days);
                    });
                });
        });
    },

    reportTop5Error: function (err, vehCount, days) {
        var code = this.widgetErrorCode('TOP5KM', err, vehCount + ' vehículos, rango ' + days + ' días');
        this.updateCardBody('top5km', (code.indexOf('TIMEOUT') !== -1 ?
            l('El ranking de kilometraje está tardando demasiado.') :
            l('No se pudo cargar el ranking de kilometraje.')) + ' (' + code + ')');
    },

    // ratings.data (analytics/vehicles.php): keys[i] = [agent_id,
    // "placa - conductor - serie", modelo], veh_driving_dist[i] = km del
    // vehículo i, alineado 1:1 con keys. Ver spec/api.md. Lanza si el shape
    // no está, está desalineado, o no hay ningún km > 0 — eso dispara el
    // fallback a reports.php (p. ej. cuentas donde ratings viene deshabilitado).
    parseRatingsTop5: function (mainData, count) {
        var rd = mainData && mainData.ratings && mainData.ratings.data;
        var keys = rd && rd.keys;
        var dist = rd && rd.veh_driving_dist;
        if (!keys || !dist || !keys.length || keys.length !== dist.length) {
            throw new Error('ratings.data ausente o desalineado');
        }
        var ranked = [];
        for (var i = 0; i < keys.length; i++) {
            var km = Number(dist[i]) || 0;
            if (km <= 0) { continue; }
            var label = (keys[i] && keys[i][1]) || String(keys[i] && keys[i][0]) || '—';
            ranked.push({ name: label, km: km, id: keys[i] && keys[i][0] });
        }
        if (ranked.length === 0) {
            throw new Error('ratings.data sin km > 0');
        }
        ranked.sort(function (a, b) { return b.km - a.km; });
        return ranked.slice(0, count || 5);
    },

    // reports.php report_type=4: report.data[fecha][vehículo] = array de
    // tramos, cada tramo con .length = km del tramo. Suma por vehículo.
    // nameToId: mapa opcional nombre→agentid para el link a Informes.
    parseReportType4: function (report, count, nameToId) {
        nameToId = nameToId || {};
        var totalsByVehicle = {};
        var dateGroups = (report && report.data) || {};

        for (var dateKey in dateGroups) {
            if (!dateGroups.hasOwnProperty(dateKey)) {
                continue;
            }
            var vehGroups = dateGroups[dateKey];
            for (var vehKey in vehGroups) {
                if (!vehGroups.hasOwnProperty(vehKey)) {
                    continue;
                }
                var trips = vehGroups[vehKey];
                var sum = totalsByVehicle[vehKey] || 0;
                for (var i = 0; i < trips.length; i++) {
                    sum += trips[i].length || 0;
                }
                totalsByVehicle[vehKey] = sum;
            }
        }

        var ranked = [];
        for (var name in totalsByVehicle) {
            if (totalsByVehicle.hasOwnProperty(name)) {
                ranked.push({ name: name, km: totalsByVehicle[name], id: nameToId[name] });
            }
        }
        ranked.sort(function (a, b) { return b.km - a.km; });
        return ranked.slice(0, count || 5);
    },

    // top5 = [{ name, km, id? }] ya ordenado desc (lo arma parseRatingsTop5 o
    // parseReportType4). days = ventana en días; startDate/stopDate = rango
    // real usado en la consulta (para la etiqueta y el link a Informes).
    renderTop5Km: function (top5, days, startDate, stopDate) {
        top5 = top5 || [];
        days = days || 7;
        stopDate = stopDate || new Date();
        if (!startDate) {
            startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
        }

        if (top5.length === 0) {
            this.updateCardBody('top5km', l('Sin datos de kilometraje para el período.'));
            return;
        }

        var startMs = startDate.getTime();
        var stopMs = stopDate.getTime();

        // Barra apilada — segmento por vehículo, alto = % del total mostrado.
        // Colores fijos g2/g1/g3/g4/g5 en orden ascendente de km (diseño de
        // dev/proto-dash.html, 27 ago). Con más de 5 vehículos el ramp no da
        // — se cae a un tono único (var --g4) para no repetir colores.
        var segColors = ['var(--g2)', 'var(--g1)', 'var(--g3)', 'var(--g4)', 'var(--g5)'];
        var flatColor = top5.length > segColors.length;
        var total = 0;
        for (var s = 0; s < top5.length; s++) {
            total += top5[s].km;
        }
        var ascending = top5.slice().reverse();
        var segments = [];
        for (var a = 0; a < ascending.length; a++) {
            var segPct = total > 0 ? (ascending[a].km / total * 100) : 0;
            segments.push({
                cls: 'promatic_dashboard_enhancer-stacked-seg',
                style: 'height:' + segPct.toFixed(1) + '%;background:' +
                    (flatColor ? 'var(--g4)' : segColors[a % segColors.length]),
                title: Ext.String.htmlEncode(ascending[a].name) + ' — ' + ascending[a].km.toFixed(0) + 'km'
            });
        }

        var maxKm = top5[0].km || 1;
        var idsShown = [];
        var rankRows = [];
        for (var j = 0; j < top5.length; j++) {
            var item = top5[j];
            var hasId = item.id !== undefined && item.id !== null && item.id !== '';
            if (hasId) { idsShown.push(item.id); }
            var rowCls = 'promatic_dashboard_enhancer-rank-row' +
                (j === 0 ? ' promatic_dashboard_enhancer-rank-row--emphasized' : '') +
                (hasId ? '' : ' promatic_dashboard_enhancer-rank-row--nolink');
            var row = {
                tag: hasId ? 'a' : 'div', cls: rowCls,
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-rank-name', html: Ext.String.htmlEncode(item.name) },
                    { cls: 'promatic_dashboard_enhancer-rank-track', cn: [
                        { cls: 'promatic_dashboard_enhancer-rank-fill', style: 'width:' + (item.km / maxKm * 100).toFixed(0) + '%' }
                    ] },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-rank-val', html: item.km.toFixed(0) + 'km' },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-chev', html: '›' }
                ]
            };
            if (hasId) {
                row.href = '#';
                row.title = l('Ver informe de kilómetros de') + ' ' + Ext.String.htmlEncode(item.name);
                row['data-km-report'] = String(item.id);
                row['data-km-start'] = String(startMs);
                row['data-km-stop'] = String(stopMs);
            }
            rankRows.push(row);
        }

        var dateFmt = function (d) {
            var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            return pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear();
        };

        this.updateCardBody('top5km', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-km-widget-body',
            cn: [
                { cls: 'promatic_dashboard_enhancer-km-stack-wrap', cn: [
                    { cls: 'promatic_dashboard_enhancer-stacked-track promatic_dashboard_enhancer-stacked-track--v', cn: segments },
                    { cls: 'promatic_dashboard_enhancer-km-stack-total', cn: [
                        { tag: 'b', html: total.toFixed(0) },
                        { html: 'km &middot; ' + l('top') + ' ' + top5.length }
                    ] }
                ] },
                { cls: 'promatic_dashboard_enhancer-km-top5', cn: [
                    { cls: 'promatic_dashboard_enhancer-km-date-range', html: dateFmt(startDate) + ' — ' + dateFmt(stopDate) },
                    { cls: 'promatic_dashboard_enhancer-km-top5-label', html: l('Ranking') + ' &middot; ' + l('más recorrido') }
                ].concat(rankRows).concat([
                    { cls: 'promatic_dashboard_enhancer-km-color-legend', cn: [
                        { tag: 'span', cls: 'promatic_dashboard_enhancer-km-legend-grad' },
                        { html: l('Oscuro = más km · Claro = menos km') }
                    ] }
                ]) }
            ]
        }));

        // Link del pie de la card → informe de kilómetros de TODOS los
        // vehículos mostrados, con el mismo rango. El pie se crea con la
        // card (cardMarkup), antes de tener datos — se completa acá.
        var cardEl = Ext.get('promatic_dashboard_enhancer-card-top5km');
        var footA = cardEl && cardEl.down('.promatic_dashboard_enhancer-card__footer a');
        if (footA) {
            if (idsShown.length) {
                footA.set({
                    'data-km-report': idsShown.join(','),
                    'data-km-start': String(startMs),
                    'data-km-stop': String(stopMs)
                });
            } else {
                footA.dom.removeAttribute('data-km-report');
            }
        }
    },

    // Delegado de clicks para los links a Informes (filas del ranking + pie
    // de la card Top KM). Se bindea una vez sobre el elemento del panel.
    bindKmReportLinks: function (panel) {
        var me = this;
        var el = panel && panel.getEl && panel.getEl();
        if (!el || el._kmReportBound) { return; }
        el._kmReportBound = true;
        el.on('click', function (e) {
            var a = e.getTarget('[data-km-report]', 10, true);
            if (!a) { return; }
            e.preventDefault();
            var raw = a.getAttribute('data-km-report');
            if (!raw) { return; }
            var ids = raw.split(',').map(Number).filter(function (n) { return !isNaN(n); });
            var start = new Date(Number(a.getAttribute('data-km-start')));
            var stop = new Date(Number(a.getAttribute('data-km-stop')));
            me.openKmReport(ids, start, stop);
        });
    },

    // Abre el panel nativo de Informes con el reporte de kilómetros
    // (report_type=4) para los vehículos y el rango dados.
    openKmReport: function (vehicleIds, startDate, stopDate) {
        if (!vehicleIds || !vehicleIds.length) { return; }
        var me = this;
        try {
            if (!this.activateReportsTab()) {
                console.warn('[promatic_dashboard_enhancer] openKmReport: no se pudo activar el tab de Informes');
                return;
            }
            Ext.defer(function () {
                try {
                    me.runNativeReport(4, vehicleIds, startDate, stopDate);
                } catch (e) {
                    console.warn('[promatic_dashboard_enhancer] runNativeReport falló:', e);
                }
            }, 200);
        } catch (err) {
            console.warn('[promatic_dashboard_enhancer] openKmReport falló:', err);
        }
    },

    // Activa el tab de Informes en la navegación de PILOT. El índice varía
    // por cuenta — se busca por identidad/título/xtype y se cae al 2 (el
    // valor del ejemplo oficial de Pilot) si no se encuentra.
    activateReportsTab: function () {
        var nav = window.skeleton && skeleton.navigation;
        if (!nav || typeof nav.setActiveTab !== 'function') { return false; }
        var tabs = (nav.items && nav.items.items) || [];
        var i;
        for (i = 0; i < tabs.length; i++) {
            if (nav.reports && tabs[i] === nav.reports) { nav.setActiveTab(i); return true; }
        }
        for (i = 0; i < tabs.length; i++) {
            var t = tabs[i];
            var xt = ((t.xtype || (t.getXType && t.getXType()) || '') + '').toLowerCase();
            var ti = ((t.title || (t.tabConfig && t.tabConfig.title) || '') + '').toLowerCase();
            if (xt.indexOf('report') !== -1 || ti.indexOf('report') !== -1 || ti.indexOf('informe') !== -1) {
                nav.setActiveTab(i);
                return true;
            }
        }
        nav.setActiveTab(2);
        return true;
    },

    // Función entregada por Pilot (2026-07-17, confirmada 22 jul) para
    // disparar un reporte nativo desde código — adaptada a método. Requiere
    // que el panel de Informes ya esté activo (ver activateReportsTab).
    runNativeReport: function (reportType, vehicleIds, startDate, stopDate) {
        var reports = window.skeleton && skeleton.navigation && skeleton.navigation.reports;
        if (!reports || !reports.down) {
            console.warn('[promatic_dashboard_enhancer] runNativeReport: panel de Informes no disponible');
            return;
        }
        var reportCombo = reports.down('#report_type');
        var objectsTree = reports.down('#reports_objects_tree');
        if (!reportCombo || !objectsTree) {
            console.warn('[promatic_dashboard_enhancer] runNativeReport: controles del panel de Informes no encontrados');
            return;
        }
        var reportStore = reportCombo.getStore();
        var objectsStore = objectsTree.getStore();
        var ids = vehicleIds.map(Number);

        function submitWhenReady() {
            var rec = reportStore.findRecord('id', Number(reportType), 0, false, false, true);
            if (!rec) {
                console.error('[promatic_dashboard_enhancer] runNativeReport: report type no encontrado:', reportType);
                return;
            }
            reportCombo.setValue(rec.get('id'));
            reportCombo.setSelection(rec);
            reports.selectReport(reportCombo, rec);
            reports.down('#report_date1').setValue(startDate);
            reports.down('#report_date2').setValue(stopDate);
            objectsStore.getRoot().cascadeBy(function (node) {
                if (node.get('vehid')) {
                    node.set('checked', ids.indexOf(Number(node.get('vehid'))) !== -1);
                }
            });
            reports.reportFormSubmit();
        }

        if (!reportStore.isLoaded()) {
            reportStore.load({ callback: function () {
                if (!objectsStore.isLoaded()) { objectsStore.load({ callback: submitWhenReady }); }
                else { submitWhenReady(); }
            } });
        } else if (!objectsStore.isLoaded()) {
            objectsStore.load({ callback: submitWhenReady });
        } else {
            submitWhenReady();
        }
    },

    // -----------------------------------------------------------------------
    // Assets
    // -----------------------------------------------------------------------

    getModuleBaseUrl: function () {
        var scripts = document.getElementsByTagName('script');
        for (var i = scripts.length - 1; i >= 0; i--) {
            var src = scripts[i].src || '';
            if (src.indexOf('/Module.js') !== -1) {
                return src.substring(0, src.lastIndexOf('/') + 1);
            }
        }
        return '/store/promatic_dashboard_enhancer/';
    },

    // Carga dist/config.json y lo mergea (por sección, un nivel) sobre
    // DEFAULT_CONFIG. No bloquea el arranque: los widgets corren en el
    // 'afterrender' del panel (bastante después de initModule), para
    // entonces esto normalmente ya resolvió; si no, usan el default.
    // FUTURO (backend): agregar acá un segundo fetch a la URL del backend
    // y mergear su respuesta encima de la de config.json.
    loadConfig: function () {
        var me = this;
        var url = this.getModuleBaseUrl() + 'config.json?v=' + this.moduleBuild;

        return fetch(url, { credentials: 'same-origin' })
            .then(function (resp) {
                if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (json) {
                var merged = {};
                var section;
                for (section in me.DEFAULT_CONFIG) {
                    if (me.DEFAULT_CONFIG.hasOwnProperty(section)) {
                        merged[section] = Ext.apply({}, me.DEFAULT_CONFIG[section]);
                    }
                }
                for (section in json) {
                    if (json.hasOwnProperty(section) && section.charAt(0) !== '_' &&
                        json[section] && typeof json[section] === 'object') {
                        merged[section] = Ext.apply(merged[section] || {}, json[section]);
                    }
                }
                me.config = merged;
                console.log('[promatic_dashboard_enhancer] config.json cargado', merged);
            })
            .catch(function (err) {
                me.config = me.DEFAULT_CONFIG;
                console.warn('[promatic_dashboard_enhancer] config.json no cargó (' +
                    (err && err.message ? err.message : err) + ') — usando DEFAULT_CONFIG');
            });
    },

    loadStyles: function () {
        var css = document.createElement('link');
        css.setAttribute('rel', 'stylesheet');
        css.setAttribute('type', 'text/css');
        css.setAttribute('href', this.getModuleBaseUrl() + 'style.css?v=' + this.moduleBuild);
        document.head.appendChild(css);
    }
});
