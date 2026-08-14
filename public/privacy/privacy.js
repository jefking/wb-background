import { MemoryVault, VaultProvider } from "/vault-sdk/index.js";

const vault = new MemoryVault();
const status = document.querySelector("#connection-status");
const kindToggle = document.querySelector("#entry-kind");
const kindButtons = [...kindToggle.querySelectorAll("[data-entry-kind]")];
const keyInput = document.querySelector("#entry-key");
const valueInput = document.querySelector("#entry-value");
const saveButton = document.querySelector("#save-entry");
const editorMessage = document.querySelector("#editor-message");
const keyList = document.querySelector("#key-list");
const keyCount = document.querySelector("#key-count");
let selectedEntryKind = "secret";

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
    const { key, kind } = vault.save(keyInput.value, valueInput.value, { kind: selectedEntryKind });
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

function setEntryKind(kind, { focus = false } = {}) {
  if (kind !== "secret" && kind !== "variable") return;
  selectedEntryKind = kind;
  for (const button of kindButtons) {
    const selected = button.dataset.entryKind === kind;
    button.setAttribute("aria-pressed", String(selected));
    if (selected && focus) button.focus();
  }
  const isSecret = kind === "secret";
  valueInput.type = isSecret ? "password" : "text";
  valueInput.autocomplete = isSecret ? "new-password" : "off";
}

saveButton.addEventListener("click", saveEntry);
valueInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveEntry();
});
for (const button of kindButtons) {
  button.addEventListener("click", () => setEntryKind(button.dataset.entryKind));
}
kindToggle.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  setEntryKind(event.key === "ArrowLeft" ? "secret" : "variable", { focus: true });
});
vault.subscribe(renderKeys);
provider.listen();
setEntryKind(selectedEntryKind);
renderKeys();
