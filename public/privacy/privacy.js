import { MemoryVault, VaultProvider } from "/vault-sdk/index.js";

const vault = new MemoryVault();
const status = document.querySelector("#connection-status");
const kindInput = document.querySelector("#entry-kind");
const keyInput = document.querySelector("#entry-key");
const valueInput = document.querySelector("#entry-value");
const saveButton = document.querySelector("#save-entry");
const editorMessage = document.querySelector("#editor-message");
const keyList = document.querySelector("#key-list");
const keyCount = document.querySelector("#key-count");

const provider = new VaultProvider({
  vault,
  trustedHostOrigin: "http://127.0.0.1:8000",
  onConnectionChange({ connected }) {
    status.textContent = connected ? "Broker connected" : "Waiting for broker";
    status.className = connected ? "status ready" : "status waiting";
  }
});

function showEditorMessage(message, isError = false) {
  editorMessage.textContent = message;
  editorMessage.classList.toggle("error", isError);
}

function saveEntry() {
  try {
    const { key, kind } = vault.save(keyInput.value, valueInput.value, { kind: kindInput.value });
    valueInput.value = "";
    showEditorMessage(`Saved ${kind} “${key}” in this page’s memory.`);
  } catch (error) {
    showEditorMessage(error.message, true);
  }
}

function deleteEntry(key) {
  if (!vault.delete(key)) return;
  showEditorMessage(`Deleted “${key}”. Any grant was invalidated.`);
}

function renderKeys() {
  const entries = vault.catalog();
  keyCount.textContent = String(entries.length);
  keyList.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No variables or secrets are stored.";
    keyList.append(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "key-row";
    const label = document.createElement("div");
    const keyName = document.createElement("code");
    keyName.textContent = entry.key;
    const kind = document.createElement("span");
    kind.className = `entry-kind ${entry.kind}`;
    kind.textContent = entry.kind;
    const revision = document.createElement("span");
    revision.className = "key-meta";
    revision.textContent = `revision ${entry.revision}`;
    const value = document.createElement("span");
    value.className = `entry-value ${entry.kind}`;
    value.textContent = entry.kind === "variable"
      ? vault.get(entry.key)
      : "Hidden in UI · plaintext in page memory";
    label.append(keyName, kind, revision, value);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteEntry(entry.key));
    row.append(label, remove);
    keyList.append(row);
  }
}

function syncEntryKind() {
  const isSecret = kindInput.value === "secret";
  valueInput.type = isSecret ? "password" : "text";
  valueInput.autocomplete = isSecret ? "new-password" : "off";
}

saveButton.addEventListener("click", saveEntry);
valueInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveEntry();
});
kindInput.addEventListener("change", syncEntryKind);
vault.subscribe(renderKeys);
provider.listen();
syncEntryKind();
renderKeys();
