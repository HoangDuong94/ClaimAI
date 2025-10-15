sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/m/MessageToast",
  "sap/ui/core/Popup"
], function (ControllerExtension, MessageToast, Popup) {
  "use strict";

  return ControllerExtension.extend("kfz.claims.ui.app.ext.ClaimsOP", {
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

          // 2) PUT stream to named stream property
          const putUrl = `${serviceUrl}/Attachments(ID=${attId},IsActiveEntity=false)/content`;
          const putRes = await fetch(putUrl, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
          if (!putRes.ok) throw new Error(`PUT content failed: ${putRes.status}`);

          // 2b) Best-effort: ensure derived metadata is present
          try {
            const patchUrl = `${serviceUrl}/Attachments(ID=${attId},IsActiveEntity=false)`;
            const patchRes = await fetch(patchUrl, {
              method: "PATCH",
              headers: { "content-type": "application/json", "accept": "application/json" },
              body: JSON.stringify({ size: file.size, mediaType: file.type || "application/octet-stream" })
            });
            // ignore status; server may have derived already
          } catch (_) {}

          // 3) Side effects / Refresh
          if (this.base.getExtensionAPI && this.base.getExtensionAPI().requestSideEffects) {
            try {
              await this.base.getExtensionAPI().requestSideEffects({ sourceProperties: ["content"], navigationProperties: ["attachments"] });
            } catch (e) {
              await this.base.getExtensionAPI().refresh();
            }
          } else if (this.base.getExtensionAPI && this.base.getExtensionAPI().refresh) {
            await this.base.getExtensionAPI().refresh();
          } else if (model && model.refresh) {
            model.refresh(true);
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
