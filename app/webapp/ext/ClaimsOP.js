sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/m/MessageToast",
  "sap/ui/core/Popup"
], function (ControllerExtension, MessageToast, Popup) {
  "use strict";

  return ControllerExtension.extend("kfz.claims.ui.app.ext.ClaimsOP", {
    onInit: function () {
      var that = this;
      try {
        // Expose a global helper for targeted side-effects from outside FE controllers
        window.requestClaimSideEffects = async function () {
          try {
            var view = that.base && that.base.getView && that.base.getView();
            var extAPI = that.base && that.base.getExtensionAPI && that.base.getExtensionAPI();
            var model = view && view.getModel && view.getModel();
            var refreshed = false;
            if (extAPI && extAPI.requestSideEffects) {
              try {
                await extAPI.requestSideEffects(view && view.getBindingContext && view.getBindingContext(), {
                  sourceProperties: ["content"],
                  navigationProperties: ["attachments", "documents"]
                });
                refreshed = true;
              } catch (e1) {
                try {
                  await extAPI.requestSideEffects({
                    sourceProperties: ["content"],
                    navigationProperties: ["attachments", "documents"]
                  });
                  refreshed = true;
                } catch (e2) { /* ignore */ }
              }
            }
            if (!refreshed && extAPI && extAPI.refresh) {
              await extAPI.refresh();
              refreshed = true;
            }
            if (!refreshed && model && model.refresh) {
              model.refresh(true);
              refreshed = true;
            }
            return refreshed;
          } catch (e) {
            return false;
          }
        };
      } catch (e) { /* ignore */ }
    },
    onUploadAttachment: function () {
      const view = this.base.getView();
      const ctx = view.getBindingContext();
      if (!ctx) {
        MessageToast.show("Kein Kontext verfügbar", { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
        return;
      }
      const data = ctx.getObject();
      if (!data || data.IsActiveEntity) {
        MessageToast.show("Bitte Entwurf bearbeiten, dann hochladen.", { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
        return;
      }
      const claimId = data.ID;
      const model = view.getModel();
      const serviceUrl = ((model && model.sServiceUrl) ? model.sServiceUrl : "/service/claims").split("?")[0].replace(/\/$/, "");

      const input = document.createElement("input");
      input.type = "file";
      input.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          view.setBusy(true);
          // 1) Create draft attachment under claim
          const createUrl = `${serviceUrl}/Claims(ID=${claimId},IsActiveEntity=false)/attachments`;
          const createRes = await fetch(createUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "accept": "application/json" },
            body: JSON.stringify({ fileName: file.name, mediaType: file.type || "application/octet-stream" })
          });
          if (!createRes.ok) throw new Error(`CREATE attachment failed: ${createRes.status}`);
          const created = await createRes.json();
          const attId = created && (created.ID || created.id || created.value || (created.d && (created.d.ID || created.d.id)));
          if (!attId) throw new Error("Attachment ID fehlt nach CREATE");

          // 2) PATCH JSON with base64 to avoid DB streaming issues
          const toDataUrl = (file) => new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = (e) => reject(e);
            fr.readAsDataURL(file);
          });
          const dataUrl = await toDataUrl(file);
          const patchUrl = `${serviceUrl}/Attachments(ID=${attId},IsActiveEntity=false)`;
          const patchRes = await fetch(patchUrl, {
            method: "PATCH",
            headers: { "content-type": "application/json", "accept": "application/json" },
            body: JSON.stringify({ content: dataUrl, fileName: file.name, mediaType: file.type || "application/octet-stream" })
          });
          if (!patchRes.ok) throw new Error(`PATCH content failed: ${patchRes.status}`);

          // 3) Side effects / Refresh
          const extAPI = this.base.getExtensionAPI && this.base.getExtensionAPI();
          let refreshed = false;
          if (extAPI && extAPI.requestSideEffects) {
            try {
              await extAPI.requestSideEffects(view.getBindingContext(), { sourceProperties: ["content"], navigationProperties: ["attachments"] });
              refreshed = true;
            } catch (e1) {
              try {
                await extAPI.requestSideEffects({ sourceProperties: ["content"], navigationProperties: ["attachments"] });
                refreshed = true;
              } catch (_) {}
            }
          }
          if (!refreshed && extAPI && extAPI.refresh) {
            await extAPI.refresh();
            refreshed = true;
          }
          if (!refreshed && model && model.refresh) {
            model.refresh(true);
            refreshed = true;
          }
          if (!refreshed) {
            // Fallback: navigate to same object to force rebind
            try {
              const comp = sap && sap.ui && sap.ui.core && sap.ui.core.Component.getOwnerComponentFor(view);
              const router = comp && comp.getRouter && comp.getRouter();
              const path = view.getBindingContext() && view.getBindingContext().getPath();
              const keyMatch = path && path.match(/\((.*)\)$/);
              if (router && keyMatch && keyMatch[1]) {
                router.navTo("ClaimsObjectPage", { key: keyMatch[1] }, { replace: true });
                refreshed = true;
              }
            } catch (_) {}
          }
          MessageToast.show("Anhang hochgeladen", { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
        } catch (err) {
          MessageToast.show(err && err.message ? err.message : String(err), { my: Popup.Dock.CenterCenter, at: Popup.Dock.CenterCenter });
        } finally {
          view.setBusy(false);
        }
      };
      input.click();
    }
  });
});
