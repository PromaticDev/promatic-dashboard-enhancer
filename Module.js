Ext.define('Store.promatic_dashboard_enhancer.Module', {
    extend: 'Ext.Component',
    extensionName: 'promatic_dashboard_enhancer',
    // version: SemVer de release, se sube a mano (ver brain/INT-006).
    //   minor = lote de feedback / widget nuevo · patch = fix puntual.
    // moduleBuild: fecha+hora, lo bumpea publish-plugin.sh en cada --execute
    //   (cache-busting de style.css + traza en consola). No es la versión.
    version: '0.5.0',
    moduleBuild: '2026-09-04-1839',

    // Config runtime — fallback si dist/config.json no carga. loadConfig()
    // pisa estos valores con lo que traiga el JSON (mismo shape). A futuro
    // un backend puede servir el mismo shape y sobrescribir en caliente
    // (ver stub en loadConfig). Cambiar acá = requiere re-publicar; cambiar
    // en config.json = igual requiere re-publicar hoy, pero deja el punto
    // de extensión listo para el override remoto.
    DEFAULT_CONFIG: {
        top5km: { windowDays: 7, activeVehicleCap: 300, tripsMaxVehicles: 100, tripsBatchSize: 4, source: 'trips-v3', count: 5, kmField: 'gps' },
        // fleet.scope: 'pilot-selection' = los widgets siguen la selección
        // con checkbox del panel "Principal" de PILOT (online_tree.getChecked()).
        // 'all' = árbol Online completo. El slider del pie del dashboard
        // sobrescribe este valor por sesión (localStorage). maxVehicles =
        // tope de seguridad para no disparar jobs async en flotas enormes.
        fleet: { scope: 'pilot-selection', maxVehicles: 500 },
        // Widget "Hora Oficial" — zona horaria IANA y locale para formatear.
        clock: { timeZone: 'America/Santiago', locale: 'es-CL', label: 'Hora Oficial' }
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
                        me._lastManualRefresh = new Date();
                        me.bindKmReportLinks(panel);
                        me.bindControlsBar(panel);
                        me.bindFleetUpdates();
                        me.loadTop5KmData();
                        me.loadAlertasGenerales();
                        // Mapa de hotspots: instancia propia dentro de un
                        // Ext.panel.Panel (patrón examples/airports/Map.js,
                        // BR-PILOT-0007). buildHotspotsMapPanel monta el panel
                        // y su listener 'render' crea el MapContainer y llama
                        // loadHotspots. NUNCA toca window.mapContainer.
                        me.buildHotspotsMapPanel();
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
    // Skeleton de carga — barras grises con la forma aproximada del
    // contenido real, mientras el widget hace su primer fetch. Reemplazado
    // por updateCardBody() cuando llega el dato (o por el mensaje de error
    // del propio widget si falla). El shimmer se apaga con
    // prefers-reduced-motion (ver style.css). kind:
    //   'donut'   — Estado de Flota (2x2 de cuadrantes con % grande)
    //   'ranking' — Top KM (barra apilada + filas de ranking)
    //   'chips'   — Sin Señal GPS (3 chips en fila)
    //   'stats'   — Alertas Generales (columna de tarjetas)
    //   'map'     — Hotspots (bloque grande)
    // Devuelve un SPEC de Ext.DomHelper (objeto), no un string — se anida
    // como `cn` dentro del spec del card, que buildRacShell renderiza de una
    // sola pasada. Un string HTML acá se re-escaparía en esa pasada.
    skeletonSpec: function (kind) {
        var bar = function (w, h) {
            return { cls: 'promatic_dashboard_enhancer-sk-bar',
                style: 'width:' + w + ';height:' + (h || 12) + 'px' };
        };
        var block = function (h) {
            return { cls: 'promatic_dashboard_enhancer-sk-bar', style: 'height:' + h + 'px' };
        };
        if (kind === 'donut') {
            return { cls: 'promatic_dashboard_enhancer-sk promatic_dashboard_enhancer-sk--grid2',
                cn: [block(46), block(46), block(46), block(46)] };
        }
        if (kind === 'ranking') {
            return { cls: 'promatic_dashboard_enhancer-sk promatic_dashboard_enhancer-sk--ranking',
                cn: [block(70), bar('80%'), bar('65%'), bar('72%'), bar('50%'), bar('58%')] };
        }
        if (kind === 'chips') {
            return { cls: 'promatic_dashboard_enhancer-sk promatic_dashboard_enhancer-sk--row',
                cn: [block(40), block(40), block(40)] };
        }
        if (kind === 'stats') {
            return { cls: 'promatic_dashboard_enhancer-sk promatic_dashboard_enhancer-sk--col',
                cn: [block(50), block(50), block(50), block(50), block(50), block(50)] };
        }
        if (kind === 'map') {
            return { cls: 'promatic_dashboard_enhancer-sk', cn: [block(320)] };
        }
        return { cls: 'promatic_dashboard_enhancer-sk', cn: [bar('90%'), bar('70%'), bar('80%')] };
    },

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

        var bodySpec = {
            id: 'promatic_dashboard_enhancer-card-body-' + id,
            cls: 'promatic_dashboard_enhancer-card__body'
        };
        if (opts.bodyHtml) {
            bodySpec.html = opts.bodyHtml;
        } else if (opts.skeleton) {
            bodySpec.cn = [this.skeletonSpec(opts.skeleton)];
        } else {
            bodySpec.html = l('Cargando...');
        }

        var cn = [
            { cls: 'promatic_dashboard_enhancer-card__head', cn: headCn },
            bodySpec
        ];
        // Cards puramente informativas (reloj, buscador, logo) no llevan pie
        // "Ver en PILOT" — no hay nada nativo a lo que enlazar.
        if (!opts.noFooter) {
            cn.push({ cls: 'promatic_dashboard_enhancer-card__footer', cn: [
                { tag: 'a', href: '#', html: (opts.footerLabel || l('Ver en PILOT')) + ' ›' }
            ] });
        }

        return {
            id: 'promatic_dashboard_enhancer-card-' + id,
            cls: 'promatic_dashboard_enhancer-card' + (opts.grow2 ? ' promatic_dashboard_enhancer-card--grow-2' : ''),
            cn: cn
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
    // Bloque "Exportar Reporte / Generar Golden Report" bajo el logo.
    // PLACEHOLDER VISUAL — sin lógica (decisión 3 sep). Comunica lo que
    // viene (FR-0005: reportes visuales propios). Los controles se ven pero
    // no hacen nada; se marcan con --beta como las tarjetas de alerta sin
    // conectar.
    exportBlockMarkup: function () {
        return {
            cls: 'promatic_dashboard_enhancer-export-block',
            cn: [
                {
                    cls: 'promatic_dashboard_enhancer-export-card promatic_dashboard_enhancer-export-card--beta',
                    cn: [
                        { cls: 'promatic_dashboard_enhancer-export-card__title', html: l('Exportar Reporte') },
                        { cls: 'promatic_dashboard_enhancer-export-card__control', html: l('Seleccionar') + ' ▾' }
                    ]
                },
                {
                    cls: 'promatic_dashboard_enhancer-export-card promatic_dashboard_enhancer-export-card--beta',
                    cn: [
                        { cls: 'promatic_dashboard_enhancer-export-card__title', html: l('Generar Golden Report') },
                        { cls: 'promatic_dashboard_enhancer-export-card__control', html: '▾' }
                    ]
                }
            ]
        };
    },

    // Layout de 4 columnas (rediseño 3 sep, idea-rediseño-layout.jpg):
    //  - Col izq FIJA: reloj (grande) + Alertas Generales (vertical).
    //  - Col centro (2-3) FLEX: Sin Señal GPS (buckets horizontales) arriba,
    //    luego Estado de Flota + Top KM lado a lado, luego mapa hotspots ancho.
    //  - Col der FIJA: logo (sin header) + bloque export (placeholder).
    //  - Buscador: OCULTO — cardMarkup('buscador') se conserva pero no se
    //    monta (vuelve con FR-0006, asistente IA).
    // Para LOC/LOP: col izq y la posición de Sin Señal GPS quedan fijas;
    // solo cambian las columnas del centro (buildLopShell se adapta aparte).
    buildRacShell: function () {
        // Col 1 (4 sep, mismo lote de cambios de la pauta): solo Alertas
        // Generales — gana el alto completo de la columna. El reloj se
        // movió a col 4, debajo del logo.
        var colLeft = {
            cls: 'promatic_dashboard_enhancer-shell-col--fixed-left',
            cn: [
                this.cardMarkup('alertas_generales', {
                    title: l('Alertas Generales'),
                    hint: l('Accidentes: eventos de los últimos 30 días. Requiere mantención: recordatorios por vehículo configurados en PILOT. Las categorías "beta" aún no están conectadas.'),
                    footerLabel: l('Abrir alertas'),
                    skeleton: 'stats'
                })
            ]
        };

        // Col 2 (4 sep, pedido de Ana vía Orlando): Sin Señal GPS + Top KM
        // apiladas verticalmente, angosta — libera el ancho que ocupaba
        // "Estado de Flota" (retirado de RAC, FR-0009: es dato de LOP, que
        // hoy no está montada — updateFlotaLopCard/refreshFleetStore siguen
        // corriendo igual, solo no se monta esta card acá) sin dejar un
        // hueco. Reserva de espacio al final para un futuro widget (no
        // implementado todavía).
        var colMid = {
            cls: 'promatic_dashboard_enhancer-shell-col--mid',
            cn: [
                this.cardMarkup('gps_signal', {
                    title: l('Sin Señal GPS'),
                    hint: l('Vehículos sin conexión al servidor, agrupados por el tiempo desde su última señal recibida. Se actualiza en vivo con el árbol Online.'),
                    noFooter: true,
                    skeleton: 'chips'
                }),
                this.cardMarkup('top5km', {
                    title: l('Vehículos con Kilometraje en Exceso'),
                    hint: l('Kilómetros por vehículo en el período configurado (por defecto 7 días). Fuente: /api/v3/vehicles/trips, con respaldo al reporte de kilometraje.'),
                    footerLabel: l('Abrir reporte de kilometraje'),
                    skeleton: 'ranking'
                })
            ]
        };

        // Col 3: el mapa solo, con el doble de ancho de una columna regular
        // — gana altura/formato más cuadrado en vez del rectángulo apaisado
        // de antes. NOTA: en RAC este mapa es temporal. Los gerentes
        // (reunión 3 sep) pidieron para RAC un mapa de "vehículos
        // disponibles por sucursal" (FR-0008) — las geocercas de sucursal ya
        // están en PILOT (Ana). El heatmap de desconexión GPS (type=15) es
        // de la vista LOC/LOP. Se deja aquí como demo del mapa propio
        // funcionando (BR-PILOT-0007) hasta armar FR-0008.
        var colMap = {
            cls: 'promatic_dashboard_enhancer-shell-col--map',
            cn: [
                this.cardMarkup('hotspots', {
                    title: l('Mapa de flota (demo)'), meta: l('disponibilidad por sucursal en diseño'),
                    footerLabel: l('Abrir mapa'),
                    skeleton: 'map'
                })
            ]
        };

        var colRight = {
            cls: 'promatic_dashboard_enhancer-shell-col--fixed-right',
            cn: [
                this.cardMarkup('logo', { noFooter: true }),
                this.cardMarkup('reloj', { title: l('Hora Oficial'), noFooter: true }),
                this.exportBlockMarkup()
            ]
        };

        var shell = [
            { cls: 'promatic_dashboard_enhancer-shell-4col', cn: [colLeft, colMid, colMap, colRight] },
            this.controlsBarMarkup()
        ];

        return Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-rac-shell',
            html: Ext.DomHelper.markup(shell)
        });
    },

    // Barra de controles del pie del dashboard:
    //  - Slider de alcance: 2 posiciones explícitas — "Selección Principal"
    //    (izquierda) sigue los checkboxes del panel "Principal" de PILOT;
    //    "Toda la flota" (derecha) ignora la selección. Es un slider y no un
    //    botón toggle a propósito: el estado se lee de la posición del thumb,
    //    no hay ambigüedad de "¿avanza o retrocede al hacer click?". Override
    //    en localStorage, sin re-publicar.
    //  - Actualizar widgets: re-dispara todos los widgets sin recargar y
    //    sella la hora en la barra de resumen ("actualizado HH:MM:SS").
    controlsBarMarkup: function () {
        var isSelection = this.effectiveFleetScope() === 'pilot-selection';
        return {
            cls: 'promatic_dashboard_enhancer-controls',
            cn: [
                {
                    id: 'promatic_dashboard_enhancer-scope-slider',
                    cls: 'promatic_dashboard_enhancer-scope' +
                        (isSelection ? '' : ' is-all'),
                    role: 'switch',
                    cn: [
                        {
                            tag: 'span',
                            cls: 'promatic_dashboard_enhancer-scope__opt promatic_dashboard_enhancer-scope__opt--sel',
                            html: l('Selección Principal')
                        },
                        { tag: 'span', cls: 'promatic_dashboard_enhancer-scope__track', cn: [
                            { tag: 'span', cls: 'promatic_dashboard_enhancer-scope__thumb' }
                        ] },
                        {
                            tag: 'span',
                            cls: 'promatic_dashboard_enhancer-scope__opt promatic_dashboard_enhancer-scope__opt--all',
                            html: l('Toda la flota')
                        }
                    ]
                },
                {
                    tag: 'button', type: 'button',
                    id: 'promatic_dashboard_enhancer-btn-refresh',
                    cls: 'promatic_dashboard_enhancer-ctrl-btn promatic_dashboard_enhancer-ctrl-btn--primary',
                    html: l('Actualizar widgets')
                }
            ]
        };
    },

    // Refleja el estado efectivo en la posición del slider.
    syncScopeSlider: function () {
        var sl = Ext.get('promatic_dashboard_enhancer-scope-slider');
        if (sl) {
            sl[this.effectiveFleetScope() === 'pilot-selection' ? 'removeCls' : 'addCls']('is-all');
        }
    },

    // Fija el alcance a un modo explícito ('pilot-selection' | 'all') según
    // el lado del slider elegido. 'pilot-selection' limpia el override (es el
    // default de config); 'all' lo escribe.
    setScopeMode: function (mode) {
        if (mode === this.effectiveFleetScope()) { return; }
        this.setScopeOverride(mode === 'all' ? 'all' : null);
        this.syncScopeSlider();
        this.refreshAllWidgets();
    },

    // Re-corre todos los widgets con datos en vivo — no toca reloj/logo.
    // Sella la hora del último refresco manual (la muestra la barra de
    // resumen); antes ese texto se re-pintaba en cada datachanged del árbol
    // y parecía un reloj.
    refreshAllWidgets: function () {
        this._lastManualRefresh = new Date();
        this.refreshFleetStore();
        this.loadTop5KmData();
        this.loadAlertasGenerales();
    },

    bindControlsBar: function (panel) {
        var me = this;
        var el = panel && panel.getEl && panel.getEl();
        if (!el || el._controlsBound) { return; }
        el._controlsBound = true;

        el.on('click', function (e) {
            var slider = e.getTarget('#promatic_dashboard_enhancer-scope-slider', 5, true);
            if (slider) {
                e.preventDefault();
                // El lado clickeado decide el modo (no un toggle ciego).
                var allOpt = e.getTarget('.promatic_dashboard_enhancer-scope__opt--all', 3, true);
                var selOpt = e.getTarget('.promatic_dashboard_enhancer-scope__opt--sel', 3, true);
                if (allOpt) {
                    me.setScopeMode('all');
                } else if (selOpt) {
                    me.setScopeMode('pilot-selection');
                } else {
                    // click en el track/thumb: alterna al otro lado
                    me.setScopeMode(me.effectiveFleetScope() === 'pilot-selection' ? 'all' : 'pilot-selection');
                }
                return;
            }
            var refreshBtn = e.getTarget('#promatic_dashboard_enhancer-btn-refresh', 5, true);
            if (refreshBtn) {
                e.preventDefault();
                refreshBtn.addCls('promatic_dashboard_enhancer-ctrl-btn--busy');
                me.refreshAllWidgets();
                Ext.defer(function () {
                    var b = Ext.get('promatic_dashboard_enhancer-btn-refresh');
                    if (b) { b.removeCls('promatic_dashboard_enhancer-ctrl-btn--busy'); }
                }, 800);
            }
        });

        this.syncScopeSlider();
    },

    buildLopShell: function () {
        var rows = [
            this.rowMarkup([
                this.cardMarkup('reloj', { title: l('Hora Oficial'), noFooter: true }),
                this.cardMarkup('buscador', { title: l('Buscar un reporte…'), grow2: true, noFooter: true }),
                this.cardMarkup('logo', { title: 'LOGO', noFooter: true })
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
                    title: l('Vehículos con Kilometraje en Exceso'), meta: 'rt=4',
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
    // Alcance del dashboard, operable desde el slider del pie:
    // 'pilot-selection' = sigue la selección con checkbox del panel "Principal";
    // 'all' = flota completa del árbol Online.
    // (El filtro por lista de agent_ids en localStorage — dev override de
    // NOC-007 — se retiró el 1 sep: el slider ya da control explícito, y la
    // lista de 45 ids del demo pisaba el modo "toda la flota".)
    SCOPE_OVERRIDE_STORAGE_KEY: 'promatic_dashboard_enhancer_scope_override',

    getScopeOverride: function () {
        try {
            return (window.localStorage && localStorage.getItem(this.SCOPE_OVERRIDE_STORAGE_KEY)) || null;
        } catch (err) {
            return null;
        }
    },

    setScopeOverride: function (value) {
        try {
            if (!window.localStorage) { return; }
            if (value) {
                localStorage.setItem(this.SCOPE_OVERRIDE_STORAGE_KEY, value);
            } else {
                localStorage.removeItem(this.SCOPE_OVERRIDE_STORAGE_KEY);
            }
        } catch (err) {
            this.widgetErrorCode('SCOPE-OVERRIDE', err);
        }
    },

    // Alcance efectivo: el slider (localStorage) gana sobre config.fleet.scope.
    effectiveFleetScope: function () {
        var override = this.getScopeOverride();
        if (override === 'all' || override === 'pilot-selection') {
            return override;
        }
        var fleetCfg = (this.config && this.config.fleet) || this.DEFAULT_CONFIG.fleet;
        return fleetCfg.scope || 'all';
    },

    // agent_ids marcados con checkbox en el panel "Principal" de PILOT
    // (online_tree.getChecked()), filtrados a hojas reales — un nodo de
    // carpeta/modelo no tiene 'agentid'. Devuelve null si getChecked no está
    // disponible o no hay nada marcado (→ el caller cae a la flota completa).
    getPilotSelectionIds: function (onlineTree) {
        if (!onlineTree || typeof onlineTree.getChecked !== 'function') {
            return null;
        }
        var checked;
        try {
            checked = onlineTree.getChecked() || [];
        } catch (err) {
            this.widgetErrorCode('FLEET-SELECTION', err);
            return null;
        }
        var ids = [];
        for (var i = 0; i < checked.length; i++) {
            var node = checked[i];
            var agentid = node && (node.get ? node.get('agentid') : node.agentid);
            if (agentid) {
                ids.push(agentid);
            }
        }
        return ids.length ? ids : null;
    },

    // ¿Hay carpetas marcadas (checked) en el árbol pero colapsadas, de modo
    // que sus vehículos hijos NO están materializados como checked en el
    // store? El checkbox de una carpeta en el árbol de PILOT solo propaga
    // checked=true a los registros hijos al EXPANDIR la carpeta — con la
    // carpeta cerrada, getChecked()/cascadeBy ven la carpeta marcada pero
    // ninguna hoja. Confirmado en DEMO_CLIENT (1 sep). Ver ADR-014 y FR-0004.
    hasCollapsedCheckedFolders: function (onlineTree) {
        var store = onlineTree && onlineTree.getStore && onlineTree.getStore();
        var root = store && store.getRoot && store.getRoot();
        if (!root) { return false; }
        var found = false;
        root.cascadeBy(function (node) {
            if (found) { return false; }
            // nodo marcado, sin agentid (= carpeta/grupo), colapsado
            if (node.get('checked') && !node.get('agentid') &&
                node.isExpandable && node.isExpandable() && !node.isExpanded()) {
                found = true;
                return false;
            }
        });
        return found;
    },

    // FR-0004: expandir las carpetas marcadas pero colapsadas del árbol
    // "Principal". El checkbox de una carpeta solo propaga checked=true a los
    // vehículos hijos al EXPANDIR la carpeta, así que forzamos la expansión de
    // esas ramas. expand() es async y dispara 'checkchange' en cada hijo al
    // materializarse el checked → el listener con debounce re-renderiza solo.
    // Se dejan expandidas a propósito (el usuario ve qué entró al dashboard);
    // los checkboxes no se tocan. Devuelve true si expandió al menos una.
    expandCheckedFolders: function (onlineTree) {
        var store = onlineTree && onlineTree.getStore && onlineTree.getStore();
        var root = store && store.getRoot && store.getRoot();
        if (!root) { return false; }
        var toExpand = [];
        root.cascadeBy(function (node) {
            if (node.get('checked') && !node.get('agentid') &&
                node.isExpandable && node.isExpandable() && !node.isExpanded()) {
                toExpand.push(node);
            }
        });
        var me = this;
        for (var i = 0; i < toExpand.length; i++) {
            try {
                toExpand[i].expand();
            } catch (err) {
                this.widgetErrorCode('FLEET-EXPAND', err);
            }
        }
        // Red de seguridad: si expand() no acaba disparando 'checkchange'
        // (hijos ya checked en el modelo, solo la carpeta estaba colapsada),
        // el listener con debounce no re-renderiza. Un re-render diferido
        // único cubre ese caso. _selectionExpandRetry evita un bucle.
        if (toExpand.length > 0 && !this._selectionExpandRetry) {
            this._selectionExpandRetry = true;
            Ext.defer(function () {
                me._selectionExpandRetry = false;
                me.refreshFleetStore();
                me.loadTop5KmData();
            }, 900);
        }
        return toExpand.length > 0;
    },

    getScopedFleetRecords: function (onlineTree) {
        var records = onlineTree.getStore().getData().items;

        // Alcance: 'pilot-selection' filtra a los vehículos marcados en el
        // panel "Principal"; 'all' devuelve la flota completa del árbol Online.
        this._selectionEmpty = false;
        this._selectionCollapsed = false;
        var scope = null;
        if (this.effectiveFleetScope() === 'pilot-selection' && onlineTree &&
            typeof onlineTree.getChecked === 'function') {
            scope = this.getPilotSelectionIds(onlineTree);
            // getChecked() disponible pero ninguna hoja marcada: puede ser
            // (a) el usuario no seleccionó nada, o (b) marcó carpetas pero
            // las tiene colapsadas (PILOT no materializa los hijos hasta
            // expandir). Distinguir para dar el mensaje correcto.
            if (!scope) {
                this._selectionEmpty = true;
                // FR-0004: si hay carpetas marcadas pero colapsadas, PILOT
                // no materializó sus vehículos como checked. Forzar la
                // expansión de esas ramas; expand() dispara 'checkchange'
                // en los hijos → el listener con debounce re-renderiza. En
                // esta pasada mostramos un mensaje transitorio.
                if (this.hasCollapsedCheckedFolders(onlineTree)) {
                    this._selectionCollapsed = true;
                    this._selectionExpanding = this.expandCheckedFolders(onlineTree);
                } else {
                    this._selectionCollapsed = false;
                    this._selectionExpanding = false;
                }
                return [];
            }
        }
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

        // Re-renderizar cuando el usuario marca/desmarca vehículos en el
        // panel "Principal". checkchange se dispara una vez por hoja al
        // cascadear una carpeta — debounce para coalescer la ráfaga. El
        // handler chequea el scope efectivo en cada disparo, así el toggle
        // del pie del dashboard funciona sin re-bindear.
        var me = this;
        var onlineTree = this.getOnlineTree();
        if (!this._selectionBound && onlineTree && typeof onlineTree.on === 'function') {
            onlineTree.on('checkchange', function (node) {
                if (me.effectiveFleetScope() !== 'pilot-selection') { return; }
                // FR-0004: si marcaron una carpeta colapsada, PILOT no
                // propaga checked a los vehículos hijos hasta expandirla.
                // Forzar la expansión acá mismo — checkchange SÍ llega para
                // el nodo carpeta aunque no cascadee a los hijos ocultos.
                if (node && node.get && node.get('checked') && !node.get('agentid') &&
                    node.isExpandable && node.isExpandable() && !node.isExpanded()) {
                    try { node.expand(); } catch (err) { me.widgetErrorCode('FLEET-EXPAND', err); }
                }
                if (me._selectionTimer) { return; }
                me._selectionTimer = Ext.defer(function () {
                    me._selectionTimer = null;
                    me.refreshFleetStore();
                    me.loadTop5KmData();
                }, 600);
            });
            this._selectionBound = true;
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

    // Tope de reintentos ante la falsa pinta inicial: online_tree materializa
    // las filas del store antes de que PILOT sincronice is_server_online por
    // cada una (llega en un 'datachanged'/'update' posterior, no en la carga
    // inicial) — de lo contrario toda la flota se ve "offline" por unos
    // segundos al montar. Ver SPEC.md §3 pendiente "primera pinta Estado de
    // Flota".
    FLEET_SETTLE_MAX_RETRIES: 6,
    FLEET_SETTLE_RETRY_MS: 700,

    _refreshFleetStore: function () {
        var onlineTree = this.getOnlineTree();
        if (!onlineTree) {
            return;
        }

        var records = this.getScopedFleetRecords(onlineTree);

        // fleet.scope 'pilot-selection' sin hojas marcadas en el panel
        // "Principal": estado vacío explícito en vez de números en 0.
        if (this._selectionEmpty) {
            var msgSel;
            if (this._selectionExpanding) {
                msgSel = l('Cargando vehículos de las carpetas seleccionadas…');
            } else if (this._selectionCollapsed) {
                msgSel = l('Expande en el panel "Principal" las carpetas que marcaste para incluir sus vehículos.');
            } else {
                msgSel = l('Selecciona vehículos en el panel "Principal" para ver el resumen.');
            }
            if (this.summaryBar) { this.summaryBar.update(msgSel); }
            this.updateCardBody('flota', msgSel);
            this.updateCardBody('gps_signal', msgSel);
            return;
        }

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

        // Falsa pinta inicial: 100% offline con flota no vacía suele ser
        // is_server_online aún sin sincronizar (no un apagón real de la
        // flota completa) — reintentar antes de pintar el estado transitorio.
        if (total > 0 && offlineCount === total &&
            (this._fleetSettleAttempt || 0) < this.FLEET_SETTLE_MAX_RETRIES) {
            this._fleetSettleAttempt = (this._fleetSettleAttempt || 0) + 1;
            Ext.defer(this.refreshFleetStore, this.FLEET_SETTLE_RETRY_MS, this);
            return;
        }
        this._fleetSettleAttempt = 0;

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
    clockConfig: function () {
        var c = (this.config && this.config.clock) || this.DEFAULT_CONFIG.clock;
        return {
            timeZone: c.timeZone || 'America/Santiago',
            locale: c.locale || 'es-CL',
            label: c.label || 'Hora Oficial'
        };
    },

    chileTime: function () {
        var cfg = this.clockConfig();
        try {
            var parts = new Intl.DateTimeFormat(cfg.locale, {
                timeZone: cfg.timeZone,
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

        // El título "Hora Oficial" ya lo pone la cabecera de la card
        // (cardMarkup). El cuerpo muestra solo la hora — antes repetía el
        // rótulo y quedaba "Hora Oficial / Hora exacta Chile / HH:MM:SS".
        this.updateCardBody('reloj', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-clock',
            cn: [
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
                { tag: 'img', src: this.getModuleBaseUrl() + 'img/dashboard-enhancer-resized-small.jpg', alt: 'Dashboard Enhancer' },
                {
                    tag: 'span',
                    cls: 'promatic_dashboard_enhancer-version',
                    html: 'v' + this.version + ' — build ' + this.moduleBuild
                }
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
        // Accidentes/Mantención: dibujados a mano, outline, viewBox="0 0 24 24"
        // (stroke=currentColor, width 1.6). Ralentí/Combustible/Territorio/
        // GPS manual: assets de dev/icons/ (filled, currentColor, viewBox
        // propio) — el wrapper .stat-card__icon los escala igual.
        var svgAccidente =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 3 L21.5 20 H2.5 Z" /><line x1="12" y1="9" x2="12" y2="14" />' +
            '<circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none" /></svg>';
        var svgMantencion =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M14.7 6.3a4 4 0 0 0-5.3 5.3L4 17l3 3 5.4-5.4a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.1-2.1z" />' +
            '<path d="M7 17h.01" /></svg>';

        // Íconos de las categorías beta (aún sin datos conectados).
        // fuelv2/forbbiden-area/ralenti: assets de dev/icons/ (currentColor),
        // copiados inline para heredar el color de fondo de cada card sin
        // request HTTP extra — mismo patrón que los SVGs dibujados a mano.
        var svgRalenti =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 111.99 111.99"><g id="Capa_2" data-name="Capa 2"><g id="Capa_1-2" data-name="Capa 1"><polygon points="67.85 26.83 69.42 26.83 69.42 24.32 69.33 24.48 67.85 26.83"/><path d="M94.89,64.74a1.12,1.12,0,0,0-.62.18,1,1,0,0,0-.41.47v.42a1.88,1.88,0,0,0,.28,1.11.92.92,0,0,0,.78.4.9.9,0,0,0,.74-.36,1.51,1.51,0,0,0,.28-.93,1.47,1.47,0,0,0-.29-.94A.94.94,0,0,0,94.89,64.74Z"/><path d="M31.71,82.54a.78.78,0,0,0-.73.38,2.33,2.33,0,0,0-.25,1.2v1.73A2.7,2.7,0,0,0,31,87.14a.82.82,0,0,0,.76.43.79.79,0,0,0,.75-.41,2.73,2.73,0,0,0,.24-1.24V84.23a2.63,2.63,0,0,0-.24-1.29A.83.83,0,0,0,31.71,82.54Z"/><path d="M56,0a56,56,0,1,0,56,56A56,56,0,0,0,56,0Zm50.33,47.9.17,1-1,.17-.18-1Zm-4.2,1.76-1.35.24-.18-1,1.36-.24Zm-3.48-19,2,3.45-5.59,3.3L93,34ZM88.51,17.75l.76.64-.64.77-.77-.64Zm-2.86,3.4.77.64-.88,1.06-.77-.65ZM55.49,6.1h1v1h-1Zm0,4.44h1v1.37h-1ZM44.31,24.32a1.48,1.48,0,0,1-.3.9,1.85,1.85,0,0,1-.78.63,1.75,1.75,0,0,1,.89.65,1.7,1.7,0,0,1,.3,1A1.88,1.88,0,0,1,43.73,29a2.78,2.78,0,0,1-1.83.57A2.6,2.6,0,0,1,40.16,29a1.83,1.83,0,0,1-.68-1.48h1.41a.82.82,0,0,0,.3.65,1.11,1.11,0,0,0,.74.26,1.1,1.1,0,0,0,.79-.27.93.93,0,0,0,.29-.71c0-.71-.39-1.06-1.17-1.06h-.75v-1.1h.75a1.07,1.07,0,0,0,.8-.27,1,1,0,0,0,.26-.72.85.85,0,0,0-.26-.66,1,1,0,0,0-.71-.24,1,1,0,0,0-.68.22.72.72,0,0,0-.27.58H39.57a1.73,1.73,0,0,1,.3-1,1.92,1.92,0,0,1,.84-.69,2.76,2.76,0,0,1,1.19-.25,2.67,2.67,0,0,1,1.77.54A1.85,1.85,0,0,1,44.31,24.32ZM39.64,10.51l2.78,7.09L38.7,19.06,35.92,12ZM26.32,21.16l.89,1.05-.77.64-.88-1.05Zm-2.85-3.4.64.76-.76.65-.64-.77ZM10,48.68l1.35.24-.17,1-1.36-.24Zm-4.37-.77,1,.18-.17,1-1-.17ZM6.46,66.1l8-1.62.79,3.92L7.25,70Zm5.45,17.22-.5-.86.87-.5.5.86Zm3.85-2.22-.5-.86,1.19-.69.5.87ZM20,68.77H18.6V63.34l-1.68.52V62.71l2.94-1.05H20Zm-1.85-30L11.53,35l2-3.48,6.63,3.74Zm6.07.64a.85.85,0,0,0-.68-.27.92.92,0,0,0-.75.33,1.27,1.27,0,0,0-.28.86H21.1a2.39,2.39,0,0,1,.31-1.18,2.16,2.16,0,0,1,.88-.84A2.61,2.61,0,0,1,23.57,38a2.52,2.52,0,0,1,1.71.53A1.85,1.85,0,0,1,25.89,40,2.39,2.39,0,0,1,25.62,41a6.38,6.38,0,0,1-.94,1.28L23.06,44h3.06v1.14H21.25v-1l2.3-2.45a7.52,7.52,0,0,0,.7-.9,1.49,1.49,0,0,0,.22-.74A1.08,1.08,0,0,0,24.23,39.36ZM25.9,98.1l-3.09-2.54L28,89.25l3.09,2.54Zm8.22-12.43a3.57,3.57,0,0,1-.61,2.25,2.45,2.45,0,0,1-3.57,0,3.51,3.51,0,0,1-.63-2.2V84.43a3.56,3.56,0,0,1,.62-2.26,2.45,2.45,0,0,1,3.56,0,3.49,3.49,0,0,1,.63,2.2ZM58,65.1a6.39,6.39,0,0,1-7.32-2.94L22.93,70.08l-.71-2.15L50,60a5.82,5.82,0,0,1,4.43-6,6.29,6.29,0,0,1,7.74,3.91A5.75,5.75,0,0,1,58,65.1ZM71.64,28h-.8v1.54H69.42V28H66.51l-.06-.89,3-4.68h1.43v4.43h.8Zm.41-8.53-3.77-1.33,2.91-8.25L75,11.19Zm6.43,68.38,2.76-6H77.7V80.71h5v.79L80,87.82Zm8.66,7.93L82,90l3-2.65,5.12,5.79ZM90.87,40.5a2.1,2.1,0,0,1-.83.84,2.63,2.63,0,0,1-1.28.3,2.7,2.7,0,0,1-1.2-.26,2.08,2.08,0,0,1-.87-.73,2,2,0,0,1-.34-1.08h1.4a1,1,0,0,0,.31.69,1,1,0,0,0,.69.25.87.87,0,0,0,.74-.35,1.6,1.6,0,0,0,.26-1,1.33,1.33,0,0,0-.3-.93,1.11,1.11,0,0,0-.84-.32,1.26,1.26,0,0,0-.82.26l-.14.13-1.12-.28.41-3.61h4v1.17H88.1l-.18,1.53A2.24,2.24,0,0,1,89,36.87a2,2,0,0,1,1.59.63,2.5,2.5,0,0,1,.58,1.77A2.6,2.6,0,0,1,90.87,40.5Zm5.37,40.6-1.19-.69.5-.87,1.19.69ZM97,67.27a2.16,2.16,0,0,1-.85.87,2.43,2.43,0,0,1-1.24.31,2.3,2.3,0,0,1-1.81-.78,3,3,0,0,1-.69-2.08v-.51a4.57,4.57,0,0,1,.43-2,3.24,3.24,0,0,1,1.26-1.38A3.77,3.77,0,0,1,96,61.17h.24v1.17h-.14a2.4,2.4,0,0,0-1.54.49,2,2,0,0,0-.7,1.35,1.91,1.91,0,0,1,1.43-.58,1.83,1.83,0,0,1,1.48.66A2.71,2.71,0,0,1,97.34,66,2.66,2.66,0,0,1,97,67.27Zm3,16-.87-.5.5-.86.87.5Zm5.55-15.1-6.41-1.07.66-4,6.41,1.07Z"/><path d="M56.91,58,50,60a5.58,5.58,0,0,0,.24,1.19,5.26,5.26,0,0,0,.42,1l6.94-2Z"/></g></g></svg>';
        var svgCombustible =
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
            '<path fill="currentColor" d="m19.77 7.23l.01-.01l-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33a2.5 2.5 0 0 0 2.5 2.5c.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5a2.5 2.5 0 0 0 5 0V9c0-.69-.28-1.32-.73-1.77M12 10H6V5h6zm6 0c-.55 0-1-.45-1-1s.45-1 1-1s1 .45 1 1s-.45 1-1 1"/></svg>';
        // GPS desconectado manual: icon-unplugged.svg (dev/icons/) —
        // manipulación física del dispositivo (desenchufar/jammer), no
        // confundir con el ícono de "Sin Señal GPS" (antena tachada,
        // watermark de la card gps_signal aparte).
        var svgGpsManual =
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 48 48">' +
            '<path fill="currentColor" d="M25.6,25.6,22.2,29,19,25.8l3.4-3.4a2,2,0,0,0-2.8-2.8L16.2,23l-1.3-1.3a1.9,1.9,0,0,0-2.8,0l-3,3a9.8,9.8,0,0,0-3,7,9.1,9.1,0,0,0,1.8,5.6L4.6,40.6a1.9,1.9,0,0,0,0,2.8,1.9,1.9,0,0,0,2.8,0l3.2-3.2a10.1,10.1,0,0,0,5.9,1.9,10.2,10.2,0,0,0,7.1-2.9l3-3a2,2,0,0,0,.6-1.4,1.7,1.7,0,0,0-.6-1.4L25,31.8l3.4-3.4a2,2,0,0,0-2.8-2.8Z"/>' +
            '<path fill="currentColor" d="M43.4,4.6a1.9,1.9,0,0,0-2.8,0L37.2,8a10,10,0,0,0-13,.9l-3,3a2,2,0,0,0-.6,1.4,1.7,1.7,0,0,0,.6,1.4L32.9,26.4a1.9,1.9,0,0,0,2.8,0l3-2.9a9.9,9.9,0,0,0,2.9-7.1A10.4,10.4,0,0,0,40,10.9l3.4-3.5A1.9,1.9,0,0,0,43.4,4.6Z"/></svg>';
        var svgTerritorio =
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 1024 1023">' +
            '<path fill="currentColor" d="M512 1023q-104 0-199-40.5t-163.5-109T40.5 710T0 511t40.5-198.5t109-163T313 40.5T512 0t199 40.5t163.5 109t109 163T1024 511t-40.5 199t-109 163.5t-163.5 109t-199 40.5m222-199L512 602L290 824q100 71 222 71t222-71M128 511q0 122 70 221l222-222l-221-221q-71 100-71 222m163-313l221 220l221-220q-100-71-221-71t-221 71m534 91L604 510l222 222q70-99 70-221t-71-222"/></svg>';

        // count: número (conectada), null/undefined (falló → "N/D"),
        // o beta:true (categoría futura → badge "beta", sin número).
        var card = function (bg, title, count, iconSvg, titleAttr, isBeta) {
            var body;
            if (isBeta) {
                body = { cls: 'promatic_dashboard_enhancer-stat-card__count promatic_dashboard_enhancer-stat-card__count--beta', html: l('beta') };
            } else if (count === null || count === undefined) {
                body = { cls: 'promatic_dashboard_enhancer-stat-card__count', html: l('N/D') };
            } else {
                body = { cls: 'promatic_dashboard_enhancer-stat-card__count', html: String(count) };
            }
            // La respiración del ícono de fondo solo tiene sentido cuando
            // la card reporta una incidencia real (count > 0) — pedido de
            // Ana, pauta 4 sep: "no aportan en nada" si están siempre
            // animadas. Las demás quedan quietas, con hover simple (CSS).
            var hasIncident = !isBeta && typeof count === 'number' && count > 0;
            return {
                tag: 'a', href: '#', style: 'background:' + bg, title: titleAttr,
                cls: 'promatic_dashboard_enhancer-stat-card' +
                    (isBeta ? ' promatic_dashboard_enhancer-stat-card--beta' : '') +
                    (hasIncident ? ' promatic_dashboard_enhancer-stat-card--has-alert' : ''),
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat-card__icon', html: iconSvg },
                    { cls: 'promatic_dashboard_enhancer-stat-card__title', html: title },
                    body
                ]
            };
        };

        // Si alguna categoría CONECTADA tiene incidencias (> 0), la card entera
        // vira de azul a naranja de alerta. Las beta y las que fallaron (N/D)
        // no cuentan para esto.
        var hasAlert = (typeof accidentes === 'number' && accidentes > 0) ||
                       (typeof mantencion === 'number' && mantencion > 0);
        var gridCls = 'promatic_dashboard_enhancer-stat-card-grid' +
            (hasAlert ? ' promatic_dashboard_enhancer-stat-card-grid--alert' : '');

        this.updateCardBody('alertas_generales', Ext.DomHelper.markup({
            cls: gridCls,
            cn: [
                card('var(--g6)', l('Accidentes'), accidentes, svgAccidente,
                    l('Accidentes — events.php type=29, últimos 30 días')),
                card('var(--g7)', l('Requiere mantención'), mantencion, svgMantencion,
                    l('Recordatorios de mantención de vehículo (ptm)')),
                card('var(--g6)', l('Ralentí excesivo'), null, svgRalenti,
                    l('Ralentí acumulado sobre umbral — pendiente de conexión'), true),
                card('var(--g7)', l('Inconsistencias en Carga'), null, svgCombustible,
                    l('Carga de combustible fuera de lo esperado — pendiente de conexión'), true),
                card('var(--g6)', l('Drenaje de Combustible'), null, svgCombustible,
                    l('Baja brusca de combustible que no corresponde a una recarga — pendiente de conexión'), true),
                card('var(--g7)', l('GPS Manipulado'), null, svgGpsManual,
                    l('Desconexión intencional del equipo — pendiente de conexión'), true),
                card('var(--g6)', l('Salida de territorio nacional'), null, svgTerritorio,
                    l('Vehículo cruza la frontera — pendiente de conexión'), true)
            ]
        }));
    },

    // Hotspots de desconexión (card 'hotspots') — heatmap sobre un
    // MapContainer PROPIO (instancia nueva, NUNCA window.mapContainer, que es
    // la global del mapa Online — Sergei, respuesta 3 sep punto 4).
    // Datos: events.php type=15 ("No connection"), ventana 30 días, cada item
    // trae lat/lon. Se agrega por celda de ~0.01° y se pasa a setHeatmap.
    getMapContainerClass: function () {
        return window.MapContainer ||
            (window.Pilot && Pilot.utils && Pilot.utils.MapContainer) || null;
    },

    // Monta un Ext.panel.Panel dentro del div de mount de la card 'hotspots'
    // y crea ahí una instancia propia de MapContainer, siguiendo el patrón
    // oficial de examples/airports/Map.js (BR-PILOT-0007):
    //   - init(lat, lon, zoom, this.id + '-body', false)
    //     → el 4º arg DEBE ser el id del -body de un panel Ext YA RENDERIZADO,
    //       no un <div> arbitrario (ese era el bug: el <div> no montaba la
    //       instancia y MapContainer caía al mapa global).
    //   - checkResize() en el evento 'resize' del panel.
    // Se llama en el afterrender del panel principal, cuando el shell ya
    // está en el DOM con dimensiones.
    buildHotspotsMapPanel: function () {
        var me = this;
        var body = Ext.get('promatic_dashboard_enhancer-card-body-hotspots');
        if (!body) {
            // el shell aún no montó — reintento acotado
            me._hotspotsMountRetry = (me._hotspotsMountRetry || 0) + 1;
            if (me._hotspotsMountRetry < 40) {
                Ext.defer(me.buildHotspotsMapPanel, 300, me);
            }
            return;
        }
        if (me._hotspotsPanel) { return; } // ya montado
        if (!me.getMapContainerClass()) {
            body.setHtml(l('El mapa no está disponible en este runtime.'));
            return;
        }

        // Limpia el skeleton 'map' y monta el panel Ext ahí.
        body.setHtml('');
        me._hotspotsPanel = Ext.create('Ext.panel.Panel', {
            renderTo: body,
            cls: 'promatic_dashboard_enhancer-hotspots-map',
            bodyCls: 'promatic_dashboard_enhancer-hotspots-map-body',
            layout: 'fit',
            // Alto fijo, igual al de #card-body-hotspots en CSS (cuadrado).
            // No se ajusta dinámicamente por altura — solo por ancho
            // (ResizeObserver de más abajo dispara checkResize de Leaflet).
            height: 650,
            border: false,
            listeners: {
                render: function () {
                    try {
                        var MC = me.getMapContainerClass();
                        // Centro aproximado de Chile continental; el heatmap
                        // reajusta el encuadre a los puntos reales.
                        me._hotspotsMap = new MC('promatic_dashboard_enhancer_hotspots');
                        me._hotspotsMap.init(-33.45, -70.66, 5, this.id + '-body', false);
                        me.loadHotspots();
                        // Leaflet midió el contenedor antes de que el layout
                        // flex terminara — recalcular a los 300/700ms para
                        // que ocupe todo el ancho (rectangular, no cuadrado).
                        Ext.defer(function () {
                            if (me._hotspotsMap && me._hotspotsMap.checkResize) { me._hotspotsMap.checkResize(); }
                        }, 300);
                        Ext.defer(function () {
                            if (me._hotspotsMap && me._hotspotsMap.checkResize) { me._hotspotsMap.checkResize(); }
                        }, 700);
                        // #card-body-hotspots tiene alto fijo por CSS (650px,
                        // cuadrado) — se retiró resize:both (4 sep) porque
                        // competía con el layout responsive: al achicar la
                        // ventana el mapa quedaba "flotando" con el alto del
                        // último drag manual en vez de ajustarse al ancho
                        // real de la columna. El ResizeObserver ya NO toca
                        // la altura del panel Ext (setHeight) — solo dispara
                        // checkResize() para que Leaflet se re-mida cuando
                        // cambia el ancho de la columna (breakpoints).
                        if (window.ResizeObserver && body.dom) {
                            me._hotspotsResizeObserver = new ResizeObserver(function () {
                                if (me._hotspotsMap && me._hotspotsMap.checkResize) { me._hotspotsMap.checkResize(); }
                            });
                            me._hotspotsResizeObserver.observe(body.dom);
                        }
                    } catch (err) {
                        me.widgetErrorCode('HOTSPOTS-INIT', err);
                        this.body.setHtml(l('No se pudo inicializar el mapa de desconexión.'));
                    }
                },
                resize: function () {
                    if (me._hotspotsMap && me._hotspotsMap.checkResize) {
                        me._hotspotsMap.checkResize();
                    }
                }
            }
        });
    },

    // Se llama desde el listener 'render' de _hotspotsPanel, con la instancia
    // me._hotspotsMap ya creada. Consulta los eventos type=15 y pinta el
    // heatmap sobre esa instancia — nunca crea un MapContainer nuevo ni toca
    // el DOM de la card (eso lo maneja el panel).
    loadHotspots: function () {
        var me = this;
        var setBodyMsg = function (msg) {
            if (me._hotspotsPanel && me._hotspotsPanel.body) {
                me._hotspotsPanel.body.setHtml(msg);
            }
        };

        this.withFleetVehicleIds(function (vehIds) {
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
                    setBodyMsg(l('No se pudo cargar el mapa de desconexión.') + ' (' + code + ')');
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

        var map = this._hotspotsMap;
        if (!map) {
            console.warn('[promatic_dashboard_enhancer] hotspots: _hotspotsMap no está listo');
            return;
        }

        if (points.length === 0) {
            // Sin datos: el mapa se queda centrado en Chile, sin heatmap.
            // No se pisa el body del panel (el mapa ya está renderizado).
            return;
        }

        try {
            if (typeof map.setHeatmap === 'function') {
                map.setHeatmap(points, true, l('Desconexiones'));
            }
            // Leaflet a veces necesita recalcular tamaño tras montarse dentro
            // de un contenedor flex que terminó de dimensionar.
            if (map.checkResize) { map.checkResize(); }
        } catch (err) {
            this.widgetErrorCode('HOTSPOTS-HEATMAP', err);
        }
    },

    updateGpsSignalCard: function (b24, b48, bMore) {
        // 3 buckets en fila horizontal (rediseño 3 sep). Sin footer — las
        // fichas son el único elemento de la card. El chip "Más de 48h"
        // (--red) es el único que pulsa (@keyframes ...-alert-pulse).
        // TODO: conectar el click de cada chip al panel de alertas nativo.
        var chip = function (mod, label, count, title) {
            return {
                cls: 'promatic_dashboard_enhancer-signal-chip promatic_dashboard_enhancer-signal-chip--' + mod,
                title: title,
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-signal-chip__label', html: label },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-signal-chip__badge', html: String(count) }
                ]
            };
        };

        // Watermark de fondo — icon-no-gps-signal.svg (dev/icons/), sutil,
        // detrás de los 3 chips. currentColor hereda del color de texto de
        // la card (gris), no compite con los chips de color.
        var svgNoGps =
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
            '<g fill="none" stroke="currentColor" stroke-width="2.5">' +
            '<path stroke-linecap="round" d="m22 8l-3-3m0 0l-3-3m3 3l-3 3m3-3l3-3"/>' +
            '<path d="M9 10.03A3.515 3.515 0 0 1 13.97 15"/>' +
            '<path stroke-linejoin="round" d="M4.853 19.147c3.196 3.196 8.06 3.707 11.789 1.533c.886-.517 1.33-.776 1.357-1.302s-.471-.89-1.468-1.618c-1.848-1.35-3.667-3-5.48-4.812C9.24 11.136 7.59 9.317 6.24 7.47c-.728-.997-1.092-1.495-1.618-1.468s-.785.47-1.302 1.357c-2.174 3.73-1.663 8.593 1.533 11.79Z"/>' +
            '</g></svg>';

        this.updateCardBody('gps_signal', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-signal-body',
            cn: [
                { cls: 'promatic_dashboard_enhancer-signal-watermark', html: svgNoGps },
                {
                    cls: 'promatic_dashboard_enhancer-signal-track',
                    cn: [
                        chip('yellow', l('Menos de 24h'), b24, l('Vehículos desconectados hace menos de 24h')),
                        chip('orange', l('Entre 24 y 48h'), b48, l('Vehículos desconectados entre 24 y 48h')),
                        chip('red', l('Más de 48h'), bMore, l('Vehículos desconectados hace más de 48h o sin dato reciente'))
                    ]
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
                { cls: 'promatic_dashboard_enhancer-summary__updated', html: l('actualizado') + ' ' + Ext.Date.format(this._lastManualRefresh || new Date(), 'H:i:s') }
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

    // -----------------------------------------------------------------------
    // API v3 — /api/v3/vehicles/trips (x-legacy cmd:distance). 1 request por
    // vehículo. URL RELATIVA al host (same-origin) — un host absoluto se
    // bloquea por CORS (verificado 2026-09-03, ver spec/api.md). Devuelve
    // { code, msg, data:[tramos] }; cada tramo trae gps (km por GPS) y can
    // (km por odómetro CAN, a veces 0). data:[] si el vehículo no se movió.
    // -----------------------------------------------------------------------

    fetchVehicleTripsV3: function (agentId, tsUnixSec, teUnixSec, timeoutMs) {
        var url = '/api/v3/vehicles/trips?agent_id=' + encodeURIComponent(agentId) +
            '&ts=' + encodeURIComponent(tsUnixSec) + '&te=' + encodeURIComponent(teUnixSec);
        var ctrl = new AbortController();
        var timeout = setTimeout(function () {
            ctrl.abort();
        }, timeoutMs || 8000);

        return fetch(url, {
            method: 'GET',
            credentials: 'include',
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

    // Suma el km de todos los tramos de una respuesta de fetchVehicleTripsV3.
    // kmField: 'gps' (default, primario) | 'can'. data ausente / [] → 0.
    sumTripsKm: function (tripsResponse, kmField) {
        var field = kmField || 'gps';
        var tramos = (tripsResponse && tripsResponse.data) || [];
        var km = 0;
        for (var i = 0; i < tramos.length; i++) {
            km += Number(tramos[i][field]) || 0;
        }
        return Math.round(km * 10) / 10;
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
            var fleetCfg = (this.config && this.config.fleet) || this.DEFAULT_CONFIG.fleet;
            var maxVeh = fleetCfg.maxVehicles || 500;
            if (vehIds.length > maxVeh) {
                console.warn('[promatic_dashboard_enhancer] withFleetVehicleIds: ' + vehIds.length +
                    ' vehículos en alcance, cortando al tope de ' + maxVeh +
                    ' (fleet.maxVehicles). Marca menos vehículos en el panel "Principal" para acotar.');
                vehIds = vehIds.slice(0, maxVeh);
            }
            callback.call(this, vehIds);
            return;
        }

        if (attempt < 40) {
            // FR-0004: si estamos siguiendo la selección de PILOT y hay
            // carpetas marcadas pero colapsadas, intentar expandirlas en
            // cada reintento (barato, con guard interno) — así si el usuario
            // marca la carpeta mientras el waiter gira, se abre sola.
            if (onlineTree && this.effectiveFleetScope() === 'pilot-selection') {
                this._selectionExpandRetry = false;
                this.expandCheckedFolders(onlineTree);
            }
            Ext.defer(function () { me.withFleetVehicleIds(callback, attempt + 1); }, 500, this);
            return;
        }

        var msg;
        if (this.effectiveFleetScope() === 'pilot-selection') {
            msg = 'Alcance "selección de PILOT": no hay vehículos marcados en el panel "Principal" ' +
                '(o solo carpetas colapsadas, cuyos hijos PILOT no materializa hasta expandir). ' +
                'Marca vehículos o mueve el slider a "Toda la flota".';
        } else {
            msg = 'Alcance "toda la flota" — el árbol Online no cargó vehículos.';
        }
        console.warn('[promatic_dashboard_enhancer] withFleetVehicleIds: 0 vehículos tras 20s. ' + msg);
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
                var msg = l('Ningún vehículo con recorrido reciente.');
                if (me._selectionExpanding) {
                    msg = l('Cargando vehículos de las carpetas seleccionadas…');
                } else if (me._selectionCollapsed) {
                    msg = l('Expande en el panel "Principal" las carpetas que marcaste para incluir sus vehículos.');
                } else if (me._selectionEmpty) {
                    msg = l('Selecciona vehículos en el panel "Principal" para ver el ranking.');
                }
                me.updateCardBody('top5km', msg);
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
                        me.renderTop5Km(me.parseReportType4(report, nameToId), days, startDate, stopDate, count);
                        console.log('[promatic_dashboard_enhancer] Top KM servido por: reports');
                    });
            };
            var runRatings = function () {
                return me.fetchAnalyticsMainData(csv, 15000,
                    startDate.toISOString().slice(0, 19), stopDate.toISOString().slice(0, 19))
                    .then(function (mainData) {
                        me.renderTop5Km(me.parseRatingsTop5(mainData), days, startDate, stopDate, count);
                        console.log('[promatic_dashboard_enhancer] Top KM servido por: ratings');
                    });
            };
            var runTripsV3 = function () {
                var tripIds = vehIds.slice(0, cfg.tripsMaxVehicles || 100);
                return me._top5FromTripsV3(tripIds, startDate, stopDate, nameToId, cfg)
                    .then(function (ranked) {
                        var withKm = ranked.filter(function (x) { return x.km > 0; });
                        if (withKm.length === 0) {
                            throw new Error('trips-v3 sin km > 0');
                        }
                        me.renderTop5Km(withKm, days, startDate, stopDate, count);
                        console.log('[promatic_dashboard_enhancer] Top KM servido por: trips-v3 (' +
                            tripIds.length + ' vehículos consultados)');
                    });
            };

            var fail = function (err) { me.reportTop5Error(err, vehIds.length, days); };

            if (cfg.source === 'reports') {
                runReports().catch(fail);
            } else if (cfg.source === 'ratings') {
                runRatings().catch(function (err) {
                    console.warn('[promatic_dashboard_enhancer] Top KM: ratings falló (' +
                        (err && err.message ? err.message : err) + ') — fallback a reports');
                    runReports().catch(fail);
                });
            } else {
                // 'trips-v3' (default)
                runTripsV3().catch(function (err) {
                    console.warn('[promatic_dashboard_enhancer] Top KM: trips-v3 falló (' +
                        (err && err.message ? err.message : err) + ') — fallback a reports');
                    runReports().catch(fail);
                });
            }
        });
    },

    // Rama "trips-v3" del Top KM. Consulta /api/v3/vehicles/trips por cada
    // vehículo candidato, en lotes de cfg.tripsBatchSize (concurrentes; los
    // lotes van en serie). Un vehículo que falla cuenta 0 km y no aborta.
    // Devuelve ranked = [{name, km, id}] ordenado desc — id = agentid, name
    // del árbol si se conoce, si no el agent_id como string.
    _top5FromTripsV3: function (vehIds, startDate, stopDate, nameToId, cfg) {
        var me = this;
        var batchSize = cfg.tripsBatchSize || 4;
        var kmField = cfg.kmField || 'gps';
        var tsUnix = Math.floor(startDate.getTime() / 1000);
        var teUnix = Math.floor(stopDate.getTime() / 1000);
        var idToName = {};
        for (var nm in nameToId) {
            if (nameToId.hasOwnProperty(nm)) { idToName[Number(nameToId[nm])] = nm; }
        }

        var results = [];
        var queue = vehIds.slice();
        var PromiseImpl = (typeof Ext !== 'undefined' && Ext.Promise) ? Ext.Promise : Promise;

        function runBatch() {
            if (queue.length === 0) { return PromiseImpl.resolve(); }
            var slice = queue.splice(0, batchSize);
            var calls = slice.map(function (id) {
                return me.fetchVehicleTripsV3(id, tsUnix, teUnix, 8000)
                    .then(function (resp) {
                        results.push({ id: id, km: me.sumTripsKm(resp, kmField) });
                    })
                    .catch(function (err) {
                        console.warn('[promatic_dashboard_enhancer] Top KM trips-v3: vehículo ' +
                            id + ' falló (' + (err && err.message ? err.message : err) + ') — cuenta 0');
                        results.push({ id: id, km: 0 });
                    });
            });
            return PromiseImpl.all(calls).then(runBatch);
        }

        return runBatch().then(function () {
            var ranked = results.map(function (r) {
                return {
                    name: idToName[Number(r.id)] || String(r.id),
                    km: r.km,
                    id: r.id
                };
            });
            ranked.sort(function (a, b) { return b.km - a.km; });
            return ranked;
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
    // Devuelve el ranking COMPLETO ordenado desc (todos los vehículos con
    // km > 0). renderTop5Km corta a `count` para mostrar; el link "ver todos"
    // del pie usa la lista entera.
    parseRatingsTop5: function (mainData) {
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
        return ranked;
    },

    // reports.php report_type=4: report.data[fecha][vehículo] = array de
    // tramos, cada tramo con .length = km del tramo. Suma por vehículo.
    // nameToId: mapa opcional nombre→agentid para el link a Informes.
    // Devuelve el ranking completo ordenado desc (ver parseRatingsTop5).
    parseReportType4: function (report, nameToId) {
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
        return ranked;
    },

    // ranked = [{ name, km, id? }] COMPLETO ordenado desc. days = ventana en
    // días; startDate/stopDate = rango real de la consulta; count = cuántas
    // filas muestra la card. El link "ver todos" del pie usa todo `ranked`.
    renderTop5Km: function (ranked, days, startDate, stopDate, count) {
        ranked = ranked || [];
        days = days || 7;
        count = count || 5;
        stopDate = stopDate || new Date();
        if (!startDate) {
            startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
        }

        if (ranked.length === 0) {
            this.updateCardBody('top5km', l('Sin datos de kilometraje para el período.'));
            return;
        }

        var top5 = ranked.slice(0, count);

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
        var rankRows = [];
        for (var j = 0; j < top5.length; j++) {
            var item = top5[j];
            var hasId = item.id !== undefined && item.id !== null && item.id !== '';
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
        // vehículos del ranking (no solo los `count` que muestra la card),
        // con el mismo rango. El pie se crea con la card (cardMarkup), antes
        // de tener datos — se completa acá.
        var allIds = [];
        for (var k = 0; k < ranked.length; k++) {
            var rid = ranked[k].id;
            if (rid !== undefined && rid !== null && rid !== '') { allIds.push(rid); }
        }
        var cardEl = Ext.get('promatic_dashboard_enhancer-card-top5km');
        var footA = cardEl && cardEl.down('.promatic_dashboard_enhancer-card__footer a');
        if (footA) {
            if (allIds.length) {
                footA.set({
                    'data-km-report': allIds.join(','),
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
            // "Dividir" (explode_combo): buscar la opción "No dividir" en el
            // store por su etiqueta y setear su valueField real — NO un literal.
            // El valueField es "abbr" y "No dividir" = 3 en la cuenta de
            // pruebas, pero varía por cuenta/idioma; un setValue(0) fijo deja el
            // combo en estado inválido → explode="" en el submit → el job del
            // reporte nunca termina ("El informe está siendo creado" colgado).
            // Va después de selectReport (que reconfigura el form). Defensivo:
            // el combo puede no existir en otra cuenta.
            var explodeCombo = reports.down('#explode_combo');
            if (explodeCombo && explodeCombo.getStore) {
                var explodeStore = explodeCombo.getStore();
                var noSplit = explodeStore && explodeStore.findRecord(
                    'name', /no dividir|don't split|do not split|не разбивать/i, 0, false, false, false);
                // Fallback: "No dividir" es la última opción del store (abbr más
                // alto) en todas las cuentas vistas.
                if (!noSplit && explodeStore && explodeStore.getCount()) {
                    noSplit = explodeStore.getAt(explodeStore.getCount() - 1);
                }
                if (noSplit) {
                    explodeCombo.setValue(noSplit.get(explodeCombo.valueField || 'abbr'));
                    if (explodeCombo.setSelection) { explodeCombo.setSelection(noSplit); }
                }
            }
            objectsStore.getRoot().cascadeBy(function (node) {
                if (node.get('vehid')) {
                    node.set('checked', ids.indexOf(Number(node.get('vehid'))) !== -1);
                }
            });
            reports.reportFormSubmit();
        }

        // objectsStore.isLoaded() puede ser true con getCount()===0: los
        // hijos del root se cargan lazy vía XHR tree.php?node=root (~1.4s).
        // Marcar+submitear antes de eso da 0 seleccionados → "Seleccione 1 o
        // más objetos" (BR-PILOT-0010). Se espera a que el árbol tenga nodos
        // reales: listener 'load' con guard de count, y un poll de respaldo
        // por si el store ya está poblado y no vuelve a emitir 'load'.
        var objectsReady = function () {
            return objectsStore.getCount() > 0;
        };
        var whenObjectsReady = function (done) {
            if (objectsReady()) { done(); return; }
            var settled = false;
            var poll, giveUp;
            function onLoad() { check(); }
            function check() {
                if (settled || !objectsReady()) { return; }
                settled = true;
                objectsStore.un('load', onLoad);
                clearInterval(poll);
                clearTimeout(giveUp);
                done();
            }
            objectsStore.on('load', onLoad);
            poll = setInterval(check, 200);
            giveUp = setTimeout(function () {
                if (settled) { return; }
                settled = true;
                objectsStore.un('load', onLoad);
                clearInterval(poll);
                console.warn('[promatic_dashboard_enhancer] runNativeReport: el árbol de objetos ' +
                    'no cargó en 10s — se intenta el submit igual');
                done();
            }, 10000);
            objectsStore.load();
        };

        var afterReportStore = function () {
            whenObjectsReady(submitWhenReady);
        };

        if (!reportStore.isLoaded()) {
            reportStore.load({ callback: afterReportStore });
        } else {
            afterReportStore();
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
