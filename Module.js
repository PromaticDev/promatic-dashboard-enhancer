Ext.define('Store.promatic_dashboard_enhancer.Module', {
    extend: 'Ext.Component',
    extensionName: 'promatic_dashboard_enhancer',

    initModule: function () {
        console.log('[promatic_dashboard_enhancer] initModule: inicio');
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

    buildMainPanel: function () {
        this.summaryBar = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-summary',
            html: l('Cargando estado de flota...')
        });

        var panel = Ext.create('Ext.panel.Panel', {
            cls: 'promatic_dashboard_enhancer-panel',
            layout: {
                type: 'vbox',
                align: 'stretch'
            },
            items: [
                this.summaryBar,
                this.buildFleetGrid(),
                this.buildMileagePanel(),
                this.buildSpeedingPanel()
            ]
        });

        this.bindFleetUpdates();

        return panel;
    },

    buildMileagePanel: function () {
        this.mileageEl = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-mileage',
            html: l('Cargando kilometraje...')
        });

        var panel = Ext.create('Ext.panel.Panel', {
            title: l('Kilometraje (últimos 7 días)'),
            cls: 'promatic_dashboard_enhancer-mileage-panel',
            items: [this.mileageEl]
        });

        this.loadMileageData();

        return panel;
    },

    loadMileageData: function (attempt) {
        attempt = attempt || 0;
        console.log('[promatic_dashboard_enhancer] loadMileageData: intento ' + attempt);
        var onlineTree = this.getOnlineTree();

        if (!onlineTree) {
            console.log('[promatic_dashboard_enhancer] loadMileageData: online_tree no disponible aún');
            if (attempt < 20) {
                Ext.defer(this.loadMileageData, 500, this, [attempt + 1]);
            } else if (this.mileageEl) {
                console.log('[promatic_dashboard_enhancer] loadMileageData: se agotaron los reintentos (20)');
                this.mileageEl.update(l('No se pudo conectar al árbol de vehículos de PILOT.'));
            }
            return;
        }

        var records = onlineTree.getStore().getData().items;
        var vehIds = [];
        for (var i = 0; i < records.length; i++) {
            var agentid = records[i].get('agentid');
            if (agentid) {
                vehIds.push(agentid);
            }
        }

        console.log('[promatic_dashboard_enhancer] loadMileageData: ' + vehIds.length + ' vehículos encontrados', vehIds);

        if (vehIds.length === 0) {
            return;
        }

        var stopDate = new Date();
        var startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);

        var me = this;
        var body = this.buildMileageReportBody(vehIds.join(','), startDate, stopDate);
        console.log('[promatic_dashboard_enhancer] loadMileageData: disparando fetch a reports.php');

        // Guardrail: reports.php con muchos toggles "on" + rango de fechas +
        // varios vehículos puede ser una consulta pesada del lado de PILOT
        // (a diferencia de events.php, más liviano). Se corta sola a los 20s
        // en vez de dejar el widget colgado esperando indefinidamente.
        var ctrl = new AbortController();
        var timeout = setTimeout(function () {
            ctrl.abort();
        }, 20000);
        var startedAt = performance.now();

        // Endpoint y formato del body confirmados 21 jul 2026 interceptando la
        // request nativa del panel de Reportes — ver spec/api.md. Sin confirmar
        // todavía si veh_id con lista separada por comas trae toda la flota en
        // una sola llamada (asumido aquí) o si requiere una llamada por vehículo.
        fetch('/backend/ax/reports.php', {
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
        }).then(function (report) {
            console.log('[promatic_dashboard_enhancer] reports.php (kilometraje) tardó ' +
                ((performance.now() - startedAt) / 1000).toFixed(1) + 's');
            me.renderMileageSummary(report, vehIds.length);
        }).catch(function (err) {
            var timedOut = err && err.name === 'AbortError';
            console.error('[promatic_dashboard_enhancer] reports.php (kilometraje) falló:',
                timedOut ? 'timeout 20s' : err);
            if (me.mileageEl) {
                me.mileageEl.update(timedOut ?
                    l('El reporte de kilometraje está tardando demasiado — intenta un rango más corto.') :
                    l('No se pudo cargar el kilometraje.'));
            }
        }).finally(function () {
            clearTimeout(timeout);
        });
    },

    buildMileageReportBody: function (vehIdsCsv, startDate, stopDate) {
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
            ['report_type', '4'],
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

        this.mileageEl.update(
            '<div class="promatic_dashboard_enhancer-summary__row">' +
                '<div class="promatic_dashboard_enhancer-stat">' +
                    '<span class="promatic_dashboard_enhancer-stat__value">' + totalKm.toFixed(1) + ' km</span>' +
                    '<span class="promatic_dashboard_enhancer-stat__label">' + l('total flota') + '</span>' +
                '</div>' +
                '<div class="promatic_dashboard_enhancer-stat">' +
                    '<span class="promatic_dashboard_enhancer-stat__value">' + avgKm.toFixed(1) + ' km</span>' +
                    '<span class="promatic_dashboard_enhancer-stat__label">' + l('promedio por vehículo') + '</span>' +
                '</div>' +
            '</div>'
        );
    },

    buildSpeedingPanel: function () {
        this.speedingChartEl = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-chart',
            autoEl: { tag: 'div' },
            html: l('Cargando distribución de velocidad...')
        });

        var panel = Ext.create('Ext.panel.Panel', {
            title: l('Distribución de velocidad'),
            cls: 'promatic_dashboard_enhancer-speeding-panel',
            height: 190,
            items: [this.speedingChartEl]
        });

        this.loadSpeedingData();

        return panel;
    },

    loadSpeedingData: function () {
        var me = this;
        console.log('[promatic_dashboard_enhancer] loadSpeedingData: disparando fetch a speeding_pie.php');

        // Nota: Ext.Ajax.request reescribe rutas relativas bajo el proxy
        // /store/<extension>/ dentro del contexto de una extensión (404
        // confirmado en runtime real, 21 jul 2026) — usar fetch() nativo,
        // que sí resuelve contra el origen real de la página. Ver spec/api.md.
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
                console.error('[promatic_dashboard_enhancer] speeding_pie.php falló:', err);
                if (me.speedingChartEl) {
                    me.speedingChartEl.update(l('No se pudo cargar la distribución de velocidad.'));
                }
            });
    },

    renderSpeedingChart: function (data) {
        var me = this;

        // No usar polling con tope fijo: el componente puede no renderizarse
        // hasta que el tab se active visualmente en el layout de Ext JS, lo
        // cual puede tardar más de lo que alcanza cualquier timeout arbitrario.
        // Escuchar el evento 'render' real, sin límite.
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
            // Mismo motivo: esperar a que el layout real termine, no adivinar con tiempo fijo.
            this.speedingChartEl.on('resize', function () {
                me.renderSpeedingChart(data);
            }, this, { single: true });
            return;
        }

        // dist/dur pueden llegar como array denso ([0.1, 0.2, ...]) o como
        // objeto disperso ({2: 0.1, 5: 0.2}) cuando algún rango de velocidad
        // no tiene ningún evento en el período — confirmado en runtime real
        // 21 jul 2026 (flota mayormente detenida de noche). Normalizar a
        // array denso de 13 buckets antes de graficar.
        var bucketCount = 13;
        var distValues = [];
        var durValues = [];
        for (var i = 0; i < bucketCount; i++) {
            distValues.push(Number(data.dist && data.dist[i]) || 0);
            durValues.push(Number(data.dur && data.dur[i]) || 0);
        }

        var categories = [];
        for (var c = 0; c < bucketCount; c++) {
            // Rango de velocidad exacto por bucket sin confirmar todavía — ver spec/api.md
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

    buildFleetGrid: function () {
        this.fleetStore = Ext.create('Ext.data.Store', {
            fields: ['agentid', 'name', 'group', 'driver', 'isOnline', 'statusText', 'lastUpdate']
        });

        return Ext.create('Ext.grid.Panel', {
            store: this.fleetStore,
            flex: 1,
            columns: [
                { text: l('Vehículo'), dataIndex: 'name', flex: 2 },
                { text: l('Grupo'), dataIndex: 'group', flex: 1 },
                { text: l('Conductor'), dataIndex: 'driver', flex: 1 },
                {
                    text: l('Estado'),
                    dataIndex: 'isOnline',
                    flex: 1,
                    renderer: function (value) {
                        return value ?
                            '<span class="promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-online"></span> ' + l('En línea') :
                            '<span class="promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-offline"></span> ' + l('Desconectado');
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

        var records = onlineTree.getStore().getData().items;
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

        this.summaryBar.update(
            '<div class="promatic_dashboard_enhancer-summary__row">' +
                '<div class="promatic_dashboard_enhancer-stat">' +
                    '<span class="promatic_dashboard_enhancer-stat__value">' + total + '</span>' +
                    '<span class="promatic_dashboard_enhancer-stat__label">' + l('flota') + '</span>' +
                '</div>' +
                '<div class="promatic_dashboard_enhancer-stat">' +
                    '<span class="promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-online"></span>' +
                    '<span class="promatic_dashboard_enhancer-stat__value">' + online + '</span>' +
                    '<span class="promatic_dashboard_enhancer-stat__label">' + l('en línea') + ' (' + pct + '%)</span>' +
                '</div>' +
                '<div class="promatic_dashboard_enhancer-stat">' +
                    '<span class="promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-offline"></span>' +
                    '<span class="promatic_dashboard_enhancer-stat__value">' + (total - online) + '</span>' +
                    '<span class="promatic_dashboard_enhancer-stat__label">' + l('desconectados') + '</span>' +
                '</div>' +
                '<div class="promatic_dashboard_enhancer-summary__updated">' +
                    l('actualizado') + ' ' + Ext.Date.format(new Date(), 'H:i:s') +
                '</div>' +
            '</div>'
        );
    },

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
        css.setAttribute('href', this.getModuleBaseUrl() + 'style.css');
        document.head.appendChild(css);
    }
});
