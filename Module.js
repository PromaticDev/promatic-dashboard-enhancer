Ext.define('Store.promatic_dashboard_pilot.Module', {
    extend: 'Ext.Component',
    extensionName: 'promatic_dashboard_pilot',

    initModule: function () {
        this.loadStyles();

        var mainPanel = this.buildMainPanel();
        var navTab = this.buildNavTab(mainPanel);

        navTab.map_frame = mainPanel;

        if (window.skeleton && skeleton.navigation && typeof skeleton.navigation.add === 'function') {
            skeleton.navigation.add(navTab);
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
        return Ext.create('Ext.panel.Panel', {
            cls: 'promatic_dashboard_pilot-panel',
            layout: 'fit',
            html: '<div class="promatic_dashboard_pilot-status">' +
                l('Promatic Dashboard — conexión OK') +
                '</div>'
        });
    },

    getModuleBaseUrl: function () {
        var scripts = document.getElementsByTagName('script');
        for (var i = scripts.length - 1; i >= 0; i--) {
            var src = scripts[i].src || '';
            if (src.indexOf('/Module.js') !== -1) {
                return src.substring(0, src.lastIndexOf('/') + 1);
            }
        }
        return '/store/promatic_dashboard_pilot/';
    },

    loadStyles: function () {
        var css = document.createElement('link');
        css.setAttribute('rel', 'stylesheet');
        css.setAttribute('type', 'text/css');
        css.setAttribute('href', this.getModuleBaseUrl() + 'style.css');
        document.head.appendChild(css);
    }
});
