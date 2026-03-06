<script>
  // ... पिछला कोड ...

  function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message) return;

    addMessage(message, 'user');
    input.value = '';
    addMessage('🤔 सोच रहा हूँ...', 'bot');

    fetch('https://आपका-बैकएंड-url.onrender.com/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message })
    })
    .then(res => res.json())  // ✅ JSON पार्स करो
    .then(data => {
      const lastMsg = document.querySelector('#messages .bot-msg:last-child');
      if (lastMsg && lastMsg.innerText === '🤔 सोच रहा हूँ...') lastMsg.remove();
      
      const reply = data.reply;  // ✅ सिर्फ reply निकालो
      addMessage(reply, 'bot');
      speakReply(reply);
    })
    .catch(err => {
      // error handling
    });
  }
</script>