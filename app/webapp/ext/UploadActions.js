sap.ui.define([
  "sap/m/MessageToast",
  "sap/ui/core/Popup",
  "sap/ui/core/BusyIndicator",
  "sap/ui/core/Component"
], function (MessageToast, Popup, BusyIndicator, Component) {
  "use strict";

  function dbg() {
    try { console.log.apply(console, ["[UploadActions]"].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  function resolveContext(oEvent, oExtensionAPI) {
    // 1) Try via ExtensionAPI (Object Page view)
    const view = oExtensionAPI && oExtensionAPI.getView && oExtensionAPI.getView();
    dbg("resolveContext: extView=", !!view, view && view.getId && view.getId());
    if (view && view.getBindingContext) {
      const ctx = view.getBindingContext();
      dbg("resolveContext: extView ctx=", !!ctx);
      if (ctx) return ctx;
    }
    // 2) Walk up from event source
    const src = oEvent && oEvent.getSource && oEvent.getSource();
    dbg("resolveContext: src=", !!src, src && src.getId && src.getId());
    if (src) {
      let ctrl = src;
      while (ctrl && !(ctrl.getBindingContext && ctrl.getBindingContext())) {
        ctrl = ctrl.getParent && ctrl.getParent();
      }
      if (ctrl && ctrl.getBindingContext) {
        const ctx = ctrl.getBindingContext();
        dbg("resolveContext: ascended ctx=", !!ctx);
        if (ctx) return ctx;
      }
      // 3) Fallback: root component view context
      const comp = Component.getOwnerComponentFor(src);
      dbg("resolveContext: ownerComp=", !!comp, comp && comp.getMetadata && comp.getMetadata().getName());
      const root = comp && comp.getRootControl && comp.getRootControl();
      if (root && root.getBindingContext) {
        const rctx = root.getBindingContext();
        dbg("resolveContext: root ctx=", !!rctx);
        if (rctx) return rctx;
      }
    }
    return null;
  }

  function parseClaimFromHash() {
    try {
      const hash = String(window.location && window.location.hash || "");
      // Expect like: #/Claims(ID=...,IsActiveEntity=false)
      const m = hash.match(/Claims\(ID=([^,\)]+),IsActiveEntity=(true|false)\)/i);
      if (m && m[1]) {
        return { id: m[1], isActive: m[2] === 'true' };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function doUpload(oEvent, oExtensionAPI) {
    const ctx = resolveContext(oEvent, oExtensionAPI);
    let claimId, isActive = false, model;
    if (ctx) {
      const data = ctx.getObject && ctx.getObject();
      dbg("doUpload: ctx ok, data=", !!data, data && { ID: data.ID, IsActiveEntity: data.IsActiveEntity });
      if (!data) {
        MessageToast.show("Kein Kontext verfügbar", { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
        return;
      }
      claimId = data.ID;
      isActive = !!data.IsActiveEntity;
      model = ctx.getModel && ctx.getModel();
    } else {
      dbg("doUpload: no binding context resolved, try hash");
      const parsed = parseClaimFromHash();
      dbg("doUpload: parsed from hash=", parsed);
      if (!parsed || !parsed.id) {
        MessageToast.show("Kein Kontext verfügbar", { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
        return;
      }
      claimId = parsed.id;
      isActive = parsed.isActive;
      model = null;
    }
    if (isActive) {
      MessageToast.show("Bitte Entwurf bearbeiten, dann hochladen.", { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
      return;
    }
    const serviceUrl = ((model && model.sServiceUrl) ? model.sServiceUrl : "/service/claims").split("?")[0].replace(/\/$/, "");
    dbg("doUpload: claimId=", claimId, "serviceUrl=", serviceUrl);

    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        BusyIndicator.show(0);
        const createUrl = `${serviceUrl}/Claims(ID=${claimId},IsActiveEntity=false)/attachments`;
        dbg("create: url=", createUrl, "file:", { name: file.name, type: file.type, size: file.size });
        const createRes = await fetch(createUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "accept": "application/json" },
          body: JSON.stringify({ fileName: file.name, mediaType: file.type || "application/octet-stream" })
        });
        dbg("create: status=", createRes.status);
        if (!createRes.ok) throw new Error(`CREATE attachment failed: ${createRes.status}`);
        const created = await createRes.json();
        const attId = created && (created.ID || created.id || created.value || (created.d && (created.d.ID || created.d.id)));
        dbg("create: attId=", attId);
        if (!attId) throw new Error("Attachment ID fehlt nach CREATE");

        const putUrl = `${serviceUrl}/Attachments(ID=${attId},IsActiveEntity=false)/content`;
        dbg("put: url=", putUrl);
        const putRes = await fetch(putUrl, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
        dbg("put: status=", putRes.status);
        if (!putRes.ok) throw new Error(`PUT content failed: ${putRes.status}`);

        // Best-effort: update derived metadata if the backend didn't compute it (DB adapters differ)
        try {
          const patchUrl = `${serviceUrl}/Attachments(ID=${attId},IsActiveEntity=false)`;
          dbg("patch: url=", patchUrl, "payload:", { size: file.size, mediaType: file.type || "application/octet-stream" });
          const patchRes = await fetch(patchUrl, {
            method: "PATCH",
            headers: { "content-type": "application/json", "accept": "application/json" },
            body: JSON.stringify({ size: file.size, mediaType: file.type || "application/octet-stream" })
          });
          dbg("patch: status=", patchRes.status);
          // Ignore non-2xx; server-side hooks may already have set fields
        } catch (metaErr) {
          dbg("patch: meta update failed (ignored)", metaErr && metaErr.message);
        }

        // Try to refresh via view's controller extension API if available
        const extAPI = oExtensionAPI && (oExtensionAPI.requestSideEffects || oExtensionAPI.refresh) ? oExtensionAPI : null;
        if (extAPI && extAPI.requestSideEffects) {
          try {
            dbg("sideEffects: via ExtensionAPI.requestSideEffects");
            await extAPI.requestSideEffects({ sourceProperties: ["content"], navigationProperties: ["attachments"] });
          } catch (e) {
            dbg("sideEffects: requestSideEffects failed, fallback to refresh", e && e.message);
            await extAPI.refresh();
          }
        } else if (extAPI && extAPI.refresh) {
          dbg("refresh: via ExtensionAPI.refresh");
          await extAPI.refresh();
        } else if (model && model.refresh) {
          dbg("refresh: via model.refresh");
          model.refresh(true);
        }
        MessageToast.show("Anhang hochgeladen", { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
      } catch (err) {
        dbg("error:", err && err.message ? err.message : err);
        MessageToast.show(err && err.message ? err.message : String(err), { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
      } finally {
        BusyIndicator.hide();
      }
    };
    input.click();
  }

  return {
    onUploadAttachment: function (oEvent, oExtensionAPI) {
      try {
        doUpload(oEvent, oExtensionAPI);
      } catch (e) {
        MessageToast.show(e && e.message ? e.message : String(e), { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
      }
    }
  };
});
