// Demo app behaviour. Deliberately plain: the point is to give tests
// something real to observe, not to demonstrate a framework.

async function loadEntities() {
  const list = document.querySelector("#entities");
  try {
    const response = await fetch("/api/items");
    if (!response.ok) {
      throw new Error(`unexpected status ${response.status}`);
    }
    const items = await response.json();
    list.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement("li");
        li.dataset.testid = "entity";
        li.textContent = `${item.id} · ${item.name}`;
        return li;
      }),
    );
  } catch (error) {
    // Fail loudly in the UI. A silent catch would leave "loading…" on screen,
    // which reads as a passing test when the page is actually broken.
    const li = document.createElement("li");
    li.dataset.testid = "entity-error";
    li.textContent = `could not load entities: ${error.message}`;
    list.replaceChildren(li);
  }
}

loadEntities();
