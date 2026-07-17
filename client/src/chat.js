// Chat: a history box bottom-left whose lines fade out after a few seconds
// (all revealed again while typing), and a one-line input opened with T or
// Enter. Everything renders through textContent, so messages can't inject
// markup.

const FADE_MS = 9000;
const MAX_LINES = 40;

export class Chat {
  constructor(onSend) {
    this.box = document.getElementById('chat');
    this.input = document.getElementById('chat-input');
    this.input.addEventListener('keydown', (e) => {
      // Keep game shortcuts (WASD, hotbar digits, E) from firing while typing.
      e.stopPropagation();
      if (e.code === 'Enter') {
        const text = this.input.value.trim();
        if (text) onSend(text);
        this.closeInput();
      } else if (e.code === 'Escape') {
        this.closeInput();
      }
    });
  }

  get inputOpen() {
    return !this.input.classList.contains('hidden');
  }

  openInput() {
    this.input.value = '';
    this.input.classList.remove('hidden');
    this.box.classList.add('chatting');
    this.input.focus();
  }

  closeInput() {
    this.input.classList.add('hidden');
    this.box.classList.remove('chatting');
    this.input.blur();
  }

  /// A player line ("name: text"), or a system announcement when name is
  /// empty ("steve joined").
  add(name, text) {
    const line = document.createElement('div');
    if (name) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${name}: `;
      line.append(who, document.createTextNode(text));
    } else {
      line.className = 'system';
      line.textContent = text;
    }
    this.box.appendChild(line);
    while (this.box.children.length > MAX_LINES) this.box.firstChild.remove();
    setTimeout(() => line.classList.add('old'), FADE_MS);
  }
}
