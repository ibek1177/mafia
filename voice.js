// Голосовая связь в комнате: каждый соединён с каждым напрямую (WebRTC).
// Сигналы (предложения соединения) идут через Supabase Realtime.
// Кому меня слышно, решает игра: ночью — только своим мафиози, днём — всем живым.

const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

export class Voice {
  /**
   * @param sb клиент Supabase
   * @param roomId комната
   * @param myId мой id
   * @param extraIce дополнительные TURN-серверы (для сложных сетей)
   * @param onChange вызывается при изменениях (кто подключён, кто говорит)
   */
  constructor(sb, roomId, myId, extraIce, onChange) {
    this.sb = sb;
    this.roomId = roomId;
    this.myId = myId;
    this.ice = [...STUN, ...(extraIce || [])];
    this.onChange = onChange || (() => {});
    this.peers = new Map(); // id → {pc, track, audio, analyser, pending[]}
    this.micOn = true;
    this.allow = () => true; // (peerId) => можно ли этому игроку меня слышать
    this.local = null;
    this.channel = null;
    this.levels = new Map(); // id → громкость 0..1 (для подсветки говорящего)
    this.myLevel = 0;
    this.error = null;
  }

  get active() {
    return !!this.local;
  }

  async start() {
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      this.error = 'Нет доступа к микрофону';
      this.local = null;
      this.onChange();
      throw e;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    this.myAnalyser = this._analyser(this.local);
    this.meter = setInterval(() => this._measure(), 150);

    this.channel = this.sb.channel(`voice:${this.roomId}`, {
      config: { presence: { key: this.myId }, broadcast: { self: false } },
    });
    this.channel
      .on('presence', { event: 'sync' }, () => this._sync())
      .on('broadcast', { event: 'sig' }, ({ payload }) => this._signal(payload))
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await this.channel.track({ id: this.myId, at: Date.now() });
      });
    this.onChange();
  }

  stop() {
    clearInterval(this.meter);
    for (const id of [...this.peers.keys()]) this._drop(id);
    if (this.channel) {
      this.channel.untrack().catch(() => {});
      this.sb.removeChannel(this.channel);
    }
    this.channel = null;
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.ctx?.close().catch(() => {});
    this.onChange();
  }

  setMic(on) {
    this.micOn = on;
    this.apply();
  }

  /** Обновить, кому слышно (вызывать при смене фазы). */
  setRules(allowFn) {
    this.allow = allowFn;
    this.apply();
  }

  apply() {
    for (const [id, p] of this.peers) {
      if (p.track) p.track.enabled = this.micOn && !!this.allow(id);
    }
    this.onChange();
  }

  /** iOS иногда не включает звук сам — включить по нажатию. */
  unlockAudio() {
    this.ctx?.resume().catch(() => {});
    for (const p of this.peers.values()) p.audio?.play().catch(() => {});
  }

  _send(to, msg) {
    this.channel?.send({ type: 'broadcast', event: 'sig', payload: { ...msg, from: this.myId, to } });
  }

  _sync() {
    const state = this.channel.presenceState();
    const present = new Set(Object.keys(state).filter((k) => k !== this.myId));
    for (const id of present) {
      if (!this.peers.has(id) && this.myId < id) this._connect(id, true);
    }
    for (const id of [...this.peers.keys()]) if (!present.has(id)) this._drop(id);
    this.onChange();
  }

  _peer(id) {
    let p = this.peers.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    // у каждого собеседника своя копия микрофона: так можно выключить звук для одних и оставить для других
    const track = this.local.getAudioTracks()[0].clone();
    track.enabled = this.micOn && !!this.allow(id);
    pc.addTrack(track, this.local);
    p = { pc, track, audio: null, analyser: null, pending: [], made: false };
    this.peers.set(id, p);
    pc.onicecandidate = (e) => {
      if (e.candidate) this._send(id, { type: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (!p.audio) {
        p.audio = new Audio();
        p.audio.autoplay = true;
        p.audio.setAttribute('playsinline', '');
        document.body.appendChild(p.audio);
      }
      p.audio.srcObject = stream;
      p.audio.play().catch(() => {});
      p.analyser = this._analyser(stream);
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this._drop(id);
        // пробуем ещё раз
        if (this.myId < id) setTimeout(() => this.channel && this._connect(id, true), 1500);
      }
      this.onChange();
    };
    return p;
  }

  async _connect(id, offer) {
    if (!this.local) return;
    const p = this._peer(id);
    if (!offer) return;
    const o = await p.pc.createOffer();
    await p.pc.setLocalDescription(o);
    this._send(id, { type: 'offer', sdp: p.pc.localDescription.sdp });
  }

  async _signal(m) {
    if (!m || m.to !== this.myId || !this.local) return;
    try {
      if (m.type === 'offer') {
        // новое предложение — пересоздаём соединение
        if (this.peers.has(m.from)) this._drop(m.from);
        const p = this._peer(m.from);
        await p.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        p.made = true;
        for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
        const a = await p.pc.createAnswer();
        await p.pc.setLocalDescription(a);
        this._send(m.from, { type: 'answer', sdp: p.pc.localDescription.sdp });
      } else if (m.type === 'answer') {
        const p = this.peers.get(m.from);
        if (!p) return;
        await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        p.made = true;
        for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      } else if (m.type === 'ice') {
        const p = this.peers.get(m.from);
        if (!p) return;
        if (p.made) await p.pc.addIceCandidate(m.candidate).catch(() => {});
        else p.pending.push(m.candidate);
      }
    } catch (e) {
      console.warn('voice signal', e);
    }
  }

  _drop(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try {
      p.pc.close();
    } catch {}
    p.track?.stop();
    if (p.audio) {
      p.audio.srcObject = null;
      p.audio.remove();
    }
    this.levels.delete(id);
  }

  _analyser(stream) {
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      const a = this.ctx.createAnalyser();
      a.fftSize = 256;
      src.connect(a);
      return a;
    } catch {
      return null;
    }
  }

  _level(a) {
    if (!a) return 0;
    const buf = new Uint8Array(a.fftSize);
    a.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) * (v - 128);
    return Math.min(1, Math.sqrt(sum / buf.length) / 30);
  }

  _measure() {
    let changed = false;
    for (const [id, p] of this.peers) {
      const l = this._level(p.analyser);
      if ((l > 0.15) !== ((this.levels.get(id) || 0) > 0.15)) changed = true;
      this.levels.set(id, l);
    }
    const mine = this.micOn ? this._level(this.myAnalyser) : 0;
    if ((mine > 0.15) !== (this.myLevel > 0.15)) changed = true;
    this.myLevel = mine;
    if (changed) this.onChange();
  }

  speaking(id) {
    return id === this.myId ? this.myLevel > 0.15 : (this.levels.get(id) || 0) > 0.15;
  }

  connected(id) {
    const p = this.peers.get(id);
    return !!p && p.pc.connectionState === 'connected';
  }
}
