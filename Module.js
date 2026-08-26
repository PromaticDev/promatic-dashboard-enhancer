Ext.define('Store.promatic_dashboard_enhancer.Module', {
    extend: 'Ext.Component',
    extensionName: 'promatic_dashboard_enhancer',
    moduleBuild: '2026-08-21-01',

    initModule: function () {
        console.log('[promatic_dashboard_enhancer] BUILD ' + this.moduleBuild + ' — initModule: inicio');
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
    // Layout principal — grid de widgets (ADR-007, simplificado esta fase:
    // sin requiere_flags/requiere_modules ni skeleton/timeout multi-etapa,
    // solo el grid CSS + contrato de metadata por widget).
    // -----------------------------------------------------------------------

    buildMainPanel: function () {
        this.summaryBar = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-summary',
            html: l('Cargando estado de flota...')
        });

        var grid = Ext.create('Ext.container.Container', {
            cls: 'promatic_dashboard_enhancer-grid',
            layout: 'auto',
            items: [
                this.safeBuildWidget('estado_flota', this.buildFleetWidget),
                this.safeBuildWidget('velocidad', this.buildSpeedingWidget),
                this.safeBuildWidget('resumen_flota', this.buildFleetSummaryWidget),
                this.safeBuildWidget('kilometraje', this.buildMileageWidget),
                this.safeBuildWidget('bateria', this.buildBatteryWidget),
                this.safeBuildWidget('zonas', this.buildZonesWidget),
                this.safeBuildWidget('eventos', this.buildEventsWidget)
            ]
        });

        var panel = Ext.create('Ext.panel.Panel', {
            cls: 'promatic_dashboard_enhancer-panel',
            layout: { type: 'vbox', align: 'stretch' },
            scrollable: 'y',
            items: [this.summaryBar, grid]
        });

        this.bindFleetUpdates();

        return panel;
    },

    // Aísla la construcción sincrónica de cada widget: si uno tira un error
    // (config de Ext inválida, referencia rota, etc.), el resto del grid
    // sigue renderizando en vez de que un solo widget roto tumbe todo el panel.
    safeBuildWidget: function (id, builderFn) {
        try {
            return builderFn.call(this);
        } catch (err) {
            var code = this.widgetErrorCode('BUILD-' + id.toUpperCase(), err);
            return this.wrapWidget(id, 'small', l('Error'), Ext.create('Ext.Component', {
                html: l('No se pudo cargar este widget.') + ' (' + code + ')'
            }));
        }
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

    // Contrato de widget (ADR-007 sección 1). `size` decide la clase CSS de
    // tamaño (small/medium/large) y la altura fija asociada — el grid es
    // CSS puro (grid-template-columns + grid-column: span), sin librería de
    // layout externa, tal como decidió el ADR.
    wrapWidget: function (id, size, title, contentCmp) {
        var heights = { small: 140, medium: 220, large: 360 };

        return Ext.create('Ext.panel.Panel', {
            itemId: 'promatic_dashboard_enhancer-widget-' + id,
            cls: 'promatic_dashboard_enhancer-widget promatic_dashboard_enhancer-widget--' + size,
            title: title,
            height: heights[size] || heights.medium,
            layout: 'fit',
            items: [contentCmp]
        });
    },

    // -----------------------------------------------------------------------
    // Widget: Estado de Flota — online_tree (ya en memoria, sin llamada HTTP)
    // -----------------------------------------------------------------------

    buildFleetWidget: function () {
        return this.wrapWidget('estado_flota', 'large', l('Estado de Flota'), this.buildFleetGrid());
    },

    buildFleetGrid: function () {
        this.fleetStore = Ext.create('Ext.data.Store', {
            fields: ['agentid', 'name', 'group', 'driver', 'isOnline', 'statusText', 'lastUpdate']
        });

        return Ext.create('Ext.grid.Panel', {
            store: this.fleetStore,
            columns: [
                { text: l('Vehículo'), dataIndex: 'name', flex: 2 },
                { text: l('Grupo'), dataIndex: 'group', flex: 1 },
                { text: l('Conductor'), dataIndex: 'driver', flex: 1 },
                {
                    text: l('Estado'),
                    dataIndex: 'isOnline',
                    flex: 1,
                    renderer: function (value) {
                        return Ext.DomHelper.markup([
                            { tag: 'span', cls: 'promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-' + (value ? 'online' : 'offline') },
                            { tag: 'span', html: ' ' + (value ? l('En línea') : l('Desconectado')) }
                        ]);
                    }
                },
                { text: l('Último estado'), dataIndex: 'statusText', flex: 2 },
                { text: l('Última actualización'), dataIndex: 'lastUpdate', flex: 1 }
            ]
        });
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

    getVehicleNameById: function () {
        var onlineTree = this.getOnlineTree();
        var map = {};
        if (!onlineTree) {
            return map;
        }
        var records = this.getScopedFleetRecords(onlineTree);
        for (var i = 0; i < records.length; i++) {
            var agentid = records[i].get('agentid');
            if (agentid) {
                map[agentid] = records[i].get('name');
            }
        }
        return map;
    },

    bindFleetUpdates: function (attempt) {
        attempt = attempt || 0;
        var onlineTree = this.getOnlineTree();

        if (!onlineTree) {
            if (attempt < 20) {
                Ext.defer(this.bindFleetUpdates, 500, this, [attempt + 1]);
            } else if (this.summaryBar) {
                this.summaryBar.update(l('No se pudo conectar al árbol de vehículos de PILOT.'));
            }
            return;
        }

        onlineTree.getStore().on('datachanged', this.refreshFleetStore, this);
        onlineTree.getStore().on('update', this.refreshFleetStore, this);
        this.refreshFleetStore();
    },

    refreshFleetStore: function () {
        var onlineTree = this.getOnlineTree();
        if (!onlineTree || !this.fleetStore) {
            return;
        }

        var records = this.getScopedFleetRecords(onlineTree);
        var rows = [];

        for (var i = 0; i < records.length; i++) {
            var r = records[i];
            var agentid = r.get('agentid');

            if (!agentid) {
                continue; // nodo de grupo/carpeta, no un vehículo
            }

            rows.push({
                agentid: agentid,
                name: r.get('name'),
                group: r.get('group'),
                driver: r.get('driver'),
                isOnline: !!r.get('is_server_online'),
                statusText: r.get('status'),
                lastUpdate: r.get('msg1')
            });
        }

        this.fleetStore.loadData(rows);
        this.updateSummary();
    },

    updateSummary: function () {
        if (!this.summaryBar || !this.fleetStore) {
            return;
        }

        var total = this.fleetStore.getCount();
        var online = 0;

        this.fleetStore.each(function (rec) {
            if (rec.get('isOnline')) {
                online++;
            }
        });

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

    fetchAnalyticsMainData: function (vehIdsCsv, timeoutMs) {
        var isoDay = new Date().toISOString().slice(0, 10) + 'T00:00:00';
        var pairs = [
            ['cmd', 'get_main_data'], ['cons_value', 'l/100km'],
            ['ts', isoDay], ['te', isoDay], ['today', 'true'], ['sync', ''],
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

    // Espera a que online_tree tenga datos y devuelve la lista de agent_ids —
    // patrón compartido por todos los widgets que dependen de la flota.
    withFleetVehicleIds: function (callback) {
        var me = this;
        var onlineTree = this.getOnlineTree();

        if (!onlineTree) {
            Ext.defer(function () { me.withFleetVehicleIds(callback); }, 500, this);
            return;
        }

        var vehIds = this.getFleetVehicleIds(onlineTree);
        if (vehIds.length === 0) {
            onlineTree.getStore().on('datachanged', function () {
                me.withFleetVehicleIds(callback);
            }, this, { single: true });
            return;
        }

        callback.call(this, vehIds);
    },

    // -----------------------------------------------------------------------
    // Widget: Kilometraje (últimos 7 días) — reports.php report_type=4
    // -----------------------------------------------------------------------

    buildMileageWidget: function () {
        this.mileageEl = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-mileage',
            html: l('Cargando kilometraje...')
        });

        this.loadMileageData();

        return this.wrapWidget('kilometraje', 'medium', l('Kilometraje (últimos 7 días)'), this.mileageEl);
    },

    loadMileageData: function () {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            console.log('[promatic_dashboard_enhancer] loadMileageData: ' + vehIds.length + ' vehículos encontrados', vehIds);

            var stopDate = new Date();
            var startDate = new Date();
            startDate.setDate(startDate.getDate() - 7);
            var startedAt = performance.now();

            me.fetchReportType(4, vehIds.join(','), startDate, stopDate, 20000)
                .then(function (report) {
                    console.log('[promatic_dashboard_enhancer] reports.php (kilometraje) tardó ' +
                        ((performance.now() - startedAt) / 1000).toFixed(1) + 's');
                    me.renderMileageSummary(report, vehIds.length);
                })
                .catch(function (err) {
                    var code = me.widgetErrorCode('KM', err, vehIds.length + ' vehículos, rango 7 días');
                    if (me.mileageEl) {
                        me.mileageEl.update((code.indexOf('TIMEOUT') !== -1 ?
                            l('El reporte de kilometraje está tardando demasiado — intenta un rango más corto.') :
                            l('No se pudo cargar el kilometraje.')) + ' (' + code + ')');
                    }
                });
        });
    },

    renderMileageSummary: function (report, vehicleCount) {
        if (!this.mileageEl) {
            return;
        }

        var totalKm = 0;
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
                for (var i = 0; i < trips.length; i++) {
                    totalKm += trips[i].length || 0;
                }
            }
        }

        var avgKm = vehicleCount > 0 ? (totalKm / vehicleCount) : 0;

        this.mileageEl.update(Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-summary__row',
            cn: [
                { cls: 'promatic_dashboard_enhancer-stat', cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: totalKm.toFixed(1) + ' km' },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: l('total flota') }
                ] },
                { cls: 'promatic_dashboard_enhancer-stat', cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: avgKm.toFixed(1) + ' km' },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: l('promedio por vehículo') }
                ] }
            ]
        }));
    },

    // -----------------------------------------------------------------------
    // Widget: Distribución de velocidad — speeding_pie.php
    // -----------------------------------------------------------------------

    buildSpeedingWidget: function () {
        this.speedingChartEl = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-chart',
            autoEl: { tag: 'div' }
        });

        this.loadSpeedingData();

        return this.wrapWidget('velocidad', 'large', l('Distribución de velocidad'), this.speedingChartEl);
    },

    loadSpeedingData: function () {
        var me = this;
        console.log('[promatic_dashboard_enhancer] loadSpeedingData: disparando fetch a speeding_pie.php');

        fetch('/backend/ax/dashboard/speeding_pie.php', { credentials: 'include' })
            .then(function (resp) {
                console.log('[promatic_dashboard_enhancer] speeding_pie.php respondió HTTP ' + resp.status);
                if (!resp.ok) {
                    throw new Error('HTTP ' + resp.status);
                }
                return resp.json();
            })
            .then(function (data) {
                console.log('[promatic_dashboard_enhancer] speeding_pie.php data:', data);
                me.renderSpeedingChart(data);
            })
            .catch(function (err) {
                var code = me.widgetErrorCode('VEL', err);
                if (me.speedingChartEl) {
                    me.speedingChartEl.update(l('No se pudo cargar la distribución de velocidad.') + ' (' + code + ')');
                }
            });
    },

    renderSpeedingChart: function (data) {
        var me = this;

        if (!this.speedingChartEl || !this.speedingChartEl.rendered) {
            console.log('[promatic_dashboard_enhancer] renderSpeedingChart: esperando evento render...');
            this.speedingChartEl.on('render', function () {
                me.renderSpeedingChart(data);
            }, this, { single: true });
            return;
        }

        if (!window.Highcharts) {
            console.log('[promatic_dashboard_enhancer] renderSpeedingChart: window.Highcharts NO disponible');
            this.speedingChartEl.update(l('Highcharts no está disponible en este runtime.'));
            return;
        }

        var containerEl = this.speedingChartEl.getEl().dom;
        console.log('[promatic_dashboard_enhancer] renderSpeedingChart: ancho del contenedor = ' +
            containerEl.offsetWidth + 'px, alto = ' + containerEl.offsetHeight + 'px');

        if (containerEl.offsetWidth === 0) {
            this.speedingChartEl.on('resize', function () {
                me.renderSpeedingChart(data);
            }, this, { single: true });
            return;
        }

        // dist/dur pueden llegar como array denso o como objeto disperso
        // ({2: 0.1, 5: 0.2}) cuando algún rango de velocidad no tiene ningún
        // evento en el período — normalizar a array denso de 13 buckets.
        var bucketCount = 13;
        var distValues = [];
        var durValues = [];
        for (var i = 0; i < bucketCount; i++) {
            distValues.push(Number(data.dist && data.dist[i]) || 0);
            durValues.push(Number(data.dur && data.dur[i]) || 0);
        }

        var categories = [];
        for (var c = 0; c < bucketCount; c++) {
            categories.push(l('Rango') + ' ' + (c + 1));
        }

        var durations = durValues;

        Highcharts.chart(this.speedingChartEl.getEl().dom, {
            chart: { type: 'column', spacingTop: 4, spacingBottom: 4 },
            title: { text: null },
            xAxis: { categories: categories },
            yAxis: { title: { text: l('Distancia (km)') }, gridLineColor: '#F1F5F9' },
            plotOptions: {
                column: { borderRadius: 4, pointPadding: 0.05, groupPadding: 0.08 }
            },
            tooltip: {
                formatter: function () {
                    var seconds = durations[this.point.index] || 0;
                    var hours = Math.floor(seconds / 3600);
                    var minutes = Math.round((seconds % 3600) / 60);
                    var durationText = hours > 0 ?
                        (hours + 'h ' + minutes + 'min') :
                        (minutes + 'min');
                    var avgSpeed = seconds > 0 ? Math.round((this.y / seconds) * 3600) : 0;

                    return '<strong>' + this.key + '</strong><br/>' +
                        l('Distancia') + ': ' + this.y.toFixed(1) + ' km<br/>' +
                        l('Duración') + ': ' + durationText + '<br/>' +
                        l('Velocidad promedio') + ': ' + avgSpeed + ' km/h';
                }
            },
            series: [{ name: l('Distancia'), data: distValues, color: '#2563EB' }],
            credits: { enabled: false },
            legend: { enabled: false }
        });
    },

    // -----------------------------------------------------------------------
    // Widget: Voltaje de batería — reports.php report_type=15 (sensores
    // especiales). El nombre exacto del sensor puede variar por dispositivo
    // ("External Voltage:V:196350::1" en la cuenta de pruebas) — se busca por
    // coincidencia de substring "voltage", no por el string exacto.
    // -----------------------------------------------------------------------

    buildBatteryWidget: function () {
        this.batteryEl = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-battery',
            html: l('Cargando voltaje de batería...')
        });

        this.loadBatteryData();

        return this.wrapWidget('bateria', 'medium', l('Voltaje de batería'), this.batteryEl);
    },

    loadBatteryData: function () {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            var stopDate = new Date();
            var startDate = new Date();
            startDate.setDate(startDate.getDate() - 7);

            me.fetchReportType(15, vehIds.join(','), startDate, stopDate, 20000)
                .then(function (report) {
                    me.renderBatterySummary(report);
                })
                .catch(function (err) {
                    var code = me.widgetErrorCode('BAT', err);
                    if (me.batteryEl) {
                        me.batteryEl.update((code.indexOf('TIMEOUT') !== -1 ?
                            l('El reporte de voltaje está tardando demasiado.') :
                            l('No se pudo cargar el voltaje de batería.')) + ' (' + code + ')');
                    }
                });
        });
    },

    renderBatterySummary: function (report) {
        if (!this.batteryEl) {
            return;
        }

        var readings = [];
        var dateGroups = (report && report.data) || {};

        for (var dateKey in dateGroups) {
            if (!dateGroups.hasOwnProperty(dateKey)) {
                continue;
            }
            var vehGroups = dateGroups[dateKey];
            for (var vehName in vehGroups) {
                if (!vehGroups.hasOwnProperty(vehName)) {
                    continue;
                }
                var sensors = vehGroups[vehName] && vehGroups[vehName].sensors;
                if (!sensors) {
                    continue;
                }
                for (var sensorName in sensors) {
                    if (!sensors.hasOwnProperty(sensorName) || sensorName.toLowerCase().indexOf('voltage') === -1) {
                        continue;
                    }
                    var series = sensors[sensorName];
                    if (series && series.length) {
                        readings.push({ vehicle: vehName, volts: series[series.length - 1][1] });
                    }
                }
            }
        }

        if (readings.length === 0) {
            this.batteryEl.update(l('Sin sensor de voltaje habilitado en esta flota.'));
            return;
        }

        var items = [];
        for (var i = 0; i < readings.length; i++) {
            items.push({
                cls: 'promatic_dashboard_enhancer-stat promatic_dashboard_enhancer-stat--row',
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: Ext.String.htmlEncode(readings[i].vehicle) },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: Number(readings[i].volts).toFixed(1) + ' V' }
                ]
            });
        }
        this.batteryEl.update(Ext.DomHelper.markup(items));
    },

    // -----------------------------------------------------------------------
    // Widget: Resumen de flota (hoy) — analytics/vehicles.php get_main_data
    // Guardrail NOC-003: en flotas grandes este endpoint puede caer a un job
    // asíncrono + WebSocket en vez de responder directo — timeout corto
    // (8s) y fallback acotado a este widget, sin bloquear el resto del
    // dashboard.
    // -----------------------------------------------------------------------

    buildFleetSummaryWidget: function () {
        this.fleetSummaryEl = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-fleet-summary',
            html: l('Cargando resumen de flota...')
        });

        this.loadFleetSummaryData();

        return this.wrapWidget('resumen_flota', 'large', l('Resumen de flota (hoy)'), this.fleetSummaryEl);
    },

    loadFleetSummaryData: function () {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            me.fetchAnalyticsMainData(vehIds.join(','), 8000)
                .then(function (data) {
                    me.renderFleetSummary(data);
                })
                .catch(function (err) {
                    var code = me.widgetErrorCode('RES', err);
                    if (me.fleetSummaryEl) {
                        me.fleetSummaryEl.update((code.indexOf('TIMEOUT') !== -1 ?
                            l('El resumen de flota está tardando demasiado (cuentas con flota grande pueden requerir sincronización manual).') :
                            l('No se pudo cargar el resumen de flota.')) + ' (' + code + ')');
                    }
                });
        });
    },

    formatInfoblockValue: function (renderer, value) {
        if (renderer === 'secondsToHumanTime' && typeof secondsToHumanTime === 'function') {
            return secondsToHumanTime(value);
        }
        if ((renderer === 'volumeSSS' || renderer === 'volumeSS') && typeof volumeSS === 'function') {
            return volumeSS(value);
        }
        if ((renderer === 'mileageSSS' || renderer === 'mileageSS') && typeof mileageSS === 'function') {
            return mileageSS(value);
        }
        return value;
    },

    renderFleetSummary: function (data) {
        if (!this.fleetSummaryEl) {
            return;
        }

        // Se muestran solo los infoblocks que no se solapan con otro widget
        // ya construido (ej. "Driving distance"/"Average mileage in period"
        // quedan fuera porque el widget de Kilometraje ya cubre esa métrica
        // con la fuente preferente, report_type=4 — ver anomalía documentada
        // en spec/api.md).
        var wanted = [
            { key: 'Trips count', label: l('Viajes') },
            { key: 'Driving time', label: l('Tiempo conduciendo') },
            { key: 'Parking time', label: l('Tiempo estacionado') },
            { key: 'Fuel consumed', label: l('Combustible consumido') },
            { key: 'Average cars on line', label: l('Autos promedio en línea') },
            { key: 'Idle time', label: l('Tiempo en ralentí') }
        ];

        var infoblocks = (data && data.infoblocks) || [];
        var byTitle = {};
        for (var i = 0; i < infoblocks.length; i++) {
            if (infoblocks[i] && infoblocks[i].title) {
                byTitle[infoblocks[i].title] = infoblocks[i];
            }
        }

        var items = [];
        for (var j = 0; j < wanted.length; j++) {
            var block = byTitle[wanted[j].key];
            if (!block) {
                continue;
            }
            items.push({
                cls: 'promatic_dashboard_enhancer-stat',
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: String(this.formatInfoblockValue(block.renderer, block.info)) },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: wanted[j].label }
                ]
            });
        }

        this.fleetSummaryEl.update(items.length ? Ext.DomHelper.markup(items) : l('Sin datos de resumen para el período.'));
    },

    // -----------------------------------------------------------------------
    // Widget: Zonas ocupadas ahora — analytics/dashboard.php cmd=zones
    // -----------------------------------------------------------------------

    buildZonesWidget: function () {
        this.zonesEl = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-zones',
            html: l('Cargando geocercas ocupadas...')
        });

        this.loadZonesData();

        return this.wrapWidget('zonas', 'medium', l('Zonas ocupadas ahora'), this.zonesEl);
    },

    loadZonesData: function () {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            me.fetchDashboardCmd('zones', vehIds.join(','), 8000)
                .then(function (data) {
                    me.renderZonesSummary(data);
                })
                .catch(function (err) {
                    var code = me.widgetErrorCode('ZON', err);
                    if (me.zonesEl) {
                        me.zonesEl.update((code.indexOf('TIMEOUT') !== -1 ?
                            l('La consulta de geocercas está tardando demasiado.') :
                            l('No se pudo cargar la ocupación de geocercas.')) + ' (' + code + ')');
                    }
                });
        });
    },

    renderZonesSummary: function (data) {
        if (!this.zonesEl) {
            return;
        }

        var zoneNames = data ? Object.keys(data) : [];
        if (zoneNames.length === 0) {
            this.zonesEl.update(l('Ningún vehículo en geocerca ahora mismo.'));
            return;
        }

        var nameByAgent = this.getVehicleNameById();
        var items = [];

        for (var i = 0; i < zoneNames.length; i++) {
            var zone = zoneNames[i];
            var agentIds = data[zone] || [];
            var names = [];
            for (var j = 0; j < agentIds.length; j++) {
                names.push(Ext.String.htmlEncode(nameByAgent[agentIds[j]] || ('#' + agentIds[j])));
            }
            items.push({
                cls: 'promatic_dashboard_enhancer-stat promatic_dashboard_enhancer-stat--row',
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: Ext.String.htmlEncode(zone) },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: names.join(', ') }
                ]
            });
        }
        this.zonesEl.update(Ext.DomHelper.markup(items));
    },

    // -----------------------------------------------------------------------
    // Widget: Eventos puntuales (últimos 7 días) — events.php por type.
    // Catálogo confirmado en brain/REF-001 (21-22 jul): 8=GSM, 9=caída de
    // voltaje, 10=reabastecimiento, 11=geocerca. type=1 (ignición) queda
    // fuera — volumen demasiado alto para un contador puntual (557k
    // eventos/7 meses en la auditoría de campo).
    // -----------------------------------------------------------------------

    buildEventsWidget: function () {
        this.eventsEl = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-events',
            html: l('Cargando eventos...')
        });

        this.loadEventsData();

        return this.wrapWidget('eventos', 'medium', l('Eventos (últimos 7 días)'), this.eventsEl);
    },

    loadEventsData: function () {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            var stopDate = new Date();
            var startDate = new Date();
            startDate.setDate(startDate.getDate() - 7);
            var fmt = function (d) {
                return d.toISOString().slice(0, 10);
            };
            var vehIdsCsv = vehIds.join(',');

            var types = [
                { type: 8, label: l('Señal GSM degradada') },
                { type: 9, label: l('Caídas de voltaje') },
                { type: 10, label: l('Reabastecimientos') },
                { type: 11, label: l('Entradas/salidas de geocerca') }
            ];

            var promises = types.map(function (t) {
                return me.fetchEventCount(vehIdsCsv, t.type, fmt(startDate), fmt(stopDate))
                    .then(function (total) {
                        return { label: t.label, total: total };
                    })
                    .catch(function (err) {
                        me.widgetErrorCode('EVT-' + t.type, err);
                        return { label: t.label, total: null };
                    });
            });

            Promise.all(promises).then(function (results) {
                me.renderEventsSummary(results);
            });
        });
    },

    renderEventsSummary: function (results) {
        if (!this.eventsEl) {
            return;
        }

        var items = [];
        for (var i = 0; i < results.length; i++) {
            var value = results[i].total === null ? l('N/D') : results[i].total;
            items.push({
                cls: 'promatic_dashboard_enhancer-stat promatic_dashboard_enhancer-stat--row',
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: results[i].label },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: String(value) }
                ]
            });
        }
        this.eventsEl.update(Ext.DomHelper.markup(items));
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

    loadStyles: function () {
        var css = document.createElement('link');
        css.setAttribute('rel', 'stylesheet');
        css.setAttribute('type', 'text/css');
        css.setAttribute('href', this.getModuleBaseUrl() + 'style.css?v=' + this.moduleBuild);
        document.head.appendChild(css);
    }
});
