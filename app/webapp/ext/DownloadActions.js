sap.ui.define([
  "sap/m/MessageToast",
  "sap/ui/core/Popup"
], function (MessageToast, Popup) {
  "use strict";

  function dbg() {
    try { console.log.apply(console, ["[DownloadActions]"].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  function getServiceUrlFromContext(ctx) {
    try {
      const model = ctx && ctx.getModel && ctx.getModel();
      if (model && model.sServiceUrl) {
        return String(model.sServiceUrl).split("?")[0].replace(/\/$/, "");
      }
    } catch (e) { /* ignore */ }
    return "/service/claims";
  }

  function openDownload(url) {
    try {
      // Let the browser handle content-disposition/filename from OData service
      window.open(url, "_blank");
    } catch (e) {
      dbg("openDownload failed:", e && e.message);
    }
  }

  function findTableFromEvent(oEvent) {
    try {
      var src = oEvent && oEvent.getSource && oEvent.getSource();
      var ctrl = src;
      while (ctrl && ctrl.getMetadata && ctrl.getMetadata().getName && ctrl.getMetadata().getName() !== 'sap.ui.mdc.Table') {
        ctrl = ctrl.getParent && ctrl.getParent();
      }
      return ctrl && ctrl.getMetadata && ctrl.getMetadata().getName && ctrl.getMetadata().getName() === 'sap.ui.mdc.Table' ? ctrl : null;
    } catch (e) { return null; }
  }

  function getSelectedContextsFromTable(oTable) {
    try {
      if (!oTable) return [];
      if (typeof oTable.getSelectedContexts === 'function') {
        return oTable.getSelectedContexts();
      }
      var plugins = oTable.getPlugins && oTable.getPlugins();
      if (Array.isArray(plugins)) {
        for (var i = 0; i < plugins.length; i++) {
          var p = plugins[i];
          if (p && typeof p.getSelectedContexts === 'function') {
            return p.getSelectedContexts();
          }
        }
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function isControl(o) {
    return !!(o && o.getMetadata && typeof o.getMetadata === 'function');
  }

  function isMDCTable(o) {
    try {
      return isControl(o) && o.getMetadata().getName && o.getMetadata().getName() === 'sap.ui.mdc.Table';
    } catch (e) { return false; }
  }

  function getChildren(oCtrl) {
    var out = [];
    try {
      var mAggr = oCtrl.getMetadata().getAllAggregations();
      Object.keys(mAggr || {}).forEach(function (name) {
        try {
          var child = oCtrl.getAggregation(name);
          if (Array.isArray(child)) {
            out = out.concat(child);
          } else if (child) {
            out.push(child);
          }
        } catch (e1) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function findMDCTablesInView(oView) {
    var result = [];
    try {
      var queue = [oView];
      var seen = new Set();
      while (queue.length) {
        var ctrl = queue.shift();
        if (!ctrl || seen.has(ctrl)) continue;
        seen.add(ctrl);
        if (isMDCTable(ctrl)) {
          result.push(ctrl);
        }
        var children = getChildren(ctrl);
        if (children && children.length) {
          queue.push.apply(queue, children);
        }
      }
    } catch (e) { /* ignore */ }
    return result;
  }

  function tryFindAttachmentsTableFromView(oExtensionAPI) {
    try {
      var view = oExtensionAPI && oExtensionAPI.getView && oExtensionAPI.getView();
      if (!view) return null;
      var tables = findMDCTablesInView(view);
      dbg('view scan: mdc tables found:', tables.length);
      for (var i = 0; i < tables.length; i++) {
        var t = tables[i];
        try {
          var id = t.getId && t.getId();
          var name = t.getMetadata && t.getMetadata().getName();
          var binding = t.getRowBinding && t.getRowBinding('rows');
          var path = binding && binding.getPath && binding.getPath();
          dbg('table candidate:', id, name, 'path=', path);
          if (path && /attachments$/i.test(path)) {
            return t;
          }
          // fallback: check inner content binding path
          var inner = (typeof t.getTable === 'function') ? t.getTable() : t.getAggregation && t.getAggregation('_content');
          var innerBinding = inner && inner.getBinding && (inner.getBinding('items') || inner.getBinding('rows'));
          var innerPath = innerBinding && innerBinding.getPath && innerBinding.getPath();
          if (innerPath && /attachments$/i.test(innerPath)) {
            return t;
          }
          if (id && /attachments/i.test(id)) {
            return t;
          }
        } catch (e1) { /* ignore one table */ }
      }
      return tables.length ? tables[0] : null; // last resort
    } catch (e) { return null; }
  }

  function findViewFromEvent(oEvent) {
    try {
      var src = oEvent && oEvent.getSource && oEvent.getSource();
      var ctrl = src;
      while (ctrl) {
        if (ctrl.getMetadata && ctrl.getMetadata().getName && /\.View$/.test(ctrl.getMetadata().getName())) {
          return ctrl; // likely a sap.ui.core.mvc.XMLView
        }
        ctrl = ctrl.getParent && ctrl.getParent();
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function tryFindAttachmentsTableFromRoot(oEvent) {
    try {
      var src = oEvent && oEvent.getSource && oEvent.getSource();
      var comp = src && sap && sap.ui && sap.ui.core && sap.ui.core.Component.getOwnerComponentFor(src);
      var root = comp && comp.getRootControl && comp.getRootControl();
      if (!root) return null;
      dbg('root control:', root && root.getId && root.getId());
      var tables = findMDCTablesInView(root);
      dbg('root scan: mdc tables found:', tables.length);
      for (var i = 0; i < tables.length; i++) {
        var t = tables[i];
        try {
          var binding = t.getRowBinding && t.getRowBinding('rows');
          var path = binding && binding.getPath && binding.getPath();
          if (path && /attachments$/i.test(path)) return t;
          var inner = (typeof t.getTable === 'function') ? t.getTable() : t.getAggregation && t.getAggregation('_content');
          var innerBinding = inner && inner.getBinding && (inner.getBinding('items') || inner.getBinding('rows'));
          var innerPath = innerBinding && innerBinding.getPath && innerBinding.getPath();
          if (innerPath && /attachments$/i.test(innerPath)) return t;
        } catch (e1) { /* ignore */ }
      }
      return tables.length ? tables[0] : null;
    } catch (e) { return null; }
  }

  return {
    onDownloadAttachment: function () {
      try {
        var oArg1 = arguments[0];
        var oArg2 = arguments[1];
        var oArg3 = arguments[2];

        dbg('handler args typeof:', typeof oArg1, typeof oArg2, typeof oArg3);

        var aCtx = [];
        // Preferred FE V4 signature: (oBindingContext, aSelectedContexts)
        if (oArg2 && Array.isArray(oArg2) && oArg2.length) {
          aCtx = oArg2;
          dbg('selectedContexts length (arg2):', aCtx.length);
        } else if (oArg1 && typeof oArg1 === 'object' && typeof oArg1.getObject === 'function') {
          // Single context passed as first arg
          aCtx = [oArg1];
          dbg('single context via arg1');
        }

        var oExtensionAPI = (oArg3 && oArg3.getView) ? oArg3 : (oArg2 && oArg2.getView ? oArg2 : (oArg1 && oArg1.getView ? oArg1 : null));

        // If still empty, try ExtensionAPI selection helper if available
        if ((!aCtx || !aCtx.length) && oExtensionAPI && typeof oExtensionAPI.getSelectedContexts === 'function') {
          try {
            aCtx = oExtensionAPI.getSelectedContexts() || [];
            dbg('extAPI.getSelectedContexts length:', aCtx.length);
          } catch (eSel) { dbg('extAPI.getSelectedContexts failed:', eSel && eSel.message); }
        }

        // Last resort: try to derive by walking the view/root tree
        if (!aCtx || !aCtx.length) {
          var eventLike = (oArg1 && typeof oArg1.getSource === 'function') ? oArg1 : null;
          dbg('event-like first arg:', !!eventLike);
          var table = findTableFromEvent(eventLike) || tryFindAttachmentsTableFromView(oExtensionAPI) || findViewFromEvent(eventLike) || tryFindAttachmentsTableFromRoot(eventLike);
          dbg('found table via search:', !!table, table && table.getId && table.getId());
          var fromPlugin = getSelectedContextsFromTable(table);
          dbg('plugin getSelectedContexts length:', fromPlugin && fromPlugin.length);
          if (fromPlugin && fromPlugin.length) {
            aCtx = fromPlugin;
          }
          if ((!aCtx || !aCtx.length) && table) {
            try {
              var inner = (typeof table.getTable === 'function') ? table.getTable() : (table.getAggregation && table.getAggregation('_content'));
              dbg('inner table:', inner && inner.getMetadata && inner.getMetadata().getName());
              if (inner && typeof inner.getSelectedItems === 'function') {
                var items = inner.getSelectedItems();
                dbg('inner getSelectedItems length:', items && items.length);
                aCtx = (items || []).map(function (it) { return it && it.getBindingContext && it.getBindingContext(); }).filter(Boolean);
              } else if (inner && typeof inner.getSelectedIndices === 'function' && typeof inner.getContextByIndex === 'function') { // sap.ui.table.Table
                var idxs = inner.getSelectedIndices();
                dbg('inner getSelectedIndices length:', idxs && idxs.length);
                aCtx = (idxs || []).map(function (ix) { return inner.getContextByIndex(ix); }).filter(Boolean);
              }
            } catch (eInner) { dbg('inner table inspect failed:', eInner && eInner.message); }
          }
        }

        if (!aCtx || !aCtx.length) {
          try {
            // Last resort: inspect binding of the table to log path for debugging
            var t2 = null;
            var b = t2 && t2.getRowBinding && t2.getRowBinding('rows');
            dbg('rowBinding exists:', !!b, b && b.getPath && b.getPath());
          } catch(eBind) { dbg('rowBinding inspect failed:', eBind && eBind.message); }
          MessageToast.show("Bitte wähle einen Anhang aus.", { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
          return;
        }

        aCtx.forEach(function (ctx, idx) {
          var obj = ctx && ctx.getObject && ctx.getObject();
          dbg('ctx object keys:', obj && Object.keys(obj || {}));
          if (!obj || !obj.ID) return;
          var serviceUrl = getServiceUrlFromContext(ctx);
          var isActive = !!obj.IsActiveEntity;
          var url = `${serviceUrl}/Attachments(ID=${obj.ID},IsActiveEntity=${isActive ? 'true' : 'false'})/content/$value`;
          dbg("download url=", url);
          setTimeout(function () { openDownload(url); }, idx * 150);
        });
      } catch (e) {
        MessageToast.show(e && e.message ? e.message : String(e), { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
      }
    }
  };
});
