"""Render the kit's UI sounds from the latest earshot and write kit/sounds.json, which every page shares.

    uv run --no-project --python 3.13 --with numpy --with scipy --with soundfile --with soxr \
        python -I kit/scripts/sounds.py [--no-pull]

Clones (or fast-forwards) earshot's default branch into ~/.cache/plugins-kit/earshot, so every run uses the
newest bank; --no-pull renders from the commit already there, which leaves the existing sounds as they are when
only KIT changed. Rendering needs no models and no network beyond the clone.

Every sound is one of earshot's short, crisp UI ticks and clicks (30 to 95 ms, no thumps, no ringing). They are
matched on loudness, not peak: a 39 ms tick and a 90 ms tink with the same peak differ by 10 dB or more to the ear.
Each is set to the same 10 ms RMS, then played at LEVEL (the contents tick) plus a small per-sound offset.
Stored as 16-bit 32 kHz mono WAV data URIs (the kit is about 50 KB).
"""
import base64, io, json, os, subprocess, sys, wave

import numpy as np

REPO = 'https://github.com/Leonxlnx/earshot'
CACHE = os.path.expanduser('~/.cache/plugins-kit/earshot')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sounds.json')
SR = 32000
RMS_DB = -22    # every sound's loudest 10 ms, after normalizing (low enough that no peak needs capping)
LEVEL = -21     # playback gain in dB for an offset of 0; the contents tick, which reads as "subtle"

# event -> (earshot bank id, offset in dB from LEVEL). Keep offsets within about ±2 dB, except hover, which sits
# well under the rest because it plays without a click.
KIT = {
    'nav':      ('pro_hover_tick/ping', 0),     # a contents click glides to a section: the reference
    'step':     ('pro_hover_tick/soft', -1),    # a figure moves one step
    'select':   ('pro_click/soft', 1),          # an option is picked
    'deselect': ('pro_hover_tick/detent', -2),  # an option is cleared
    'reveal':   ('pro_hover_tick/glass', 0),    # a panel or an answer opens
    'toggle':   ('pro_hover_tick/air', -1),     # a switch, a select, the sound button
    'send':     ('pro_pop/tink', 1),            # feedback sent, or a self-check is right: a light tonal tink
    'hover':    ('pro_hover_tick/soft', -12),   # a mouse moves onto a control: the step tick, far under; at most one each 80 ms
}


def sync(pull=True):
    if not os.path.isdir(os.path.join(CACHE, '.git')):
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        subprocess.run(['git', 'clone', '-q', '--depth', '1', REPO, CACHE], check=True)
    elif pull:
        subprocess.run(['git', '-C', CACHE, 'pull', '-q', '--ff-only'], check=True)
    return subprocess.run(['git', '-C', CACHE, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()


def rms_max_db(m, sr, win=0.01):
    n = max(1, int(win * sr))
    hop = max(1, n // 4)
    return max(10 * np.log10(np.mean(m[i:i + n] ** 2) + 1e-12) for i in range(0, max(1, len(m) - n), hop))


def encode(y, sr):
    m = y.mean(axis=1) if y.ndim == 2 else y
    if sr != SR:
        import soxr
        m = soxr.resample(m, sr, SR)
    m = m * 10 ** ((RMS_DB - rms_max_db(m, SR)) / 20)
    peak = np.abs(m).max()
    if peak > 10 ** (-1 / 20):
        m *= 10 ** (-1 / 20) / peak
    n = min(len(m), int(0.008 * SR))
    m[-n:] *= np.linspace(1, 0, n) ** 2  # a short fade, so no sound ends on a click
    pcm = (np.clip(m, -1, 1) * 32767).astype('<i2').tobytes()
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm)
    return 'data:audio/wav;base64,' + base64.b64encode(buf.getvalue()).decode(), len(m) / SR, rms_max_db(m, SR)


def main():
    commit = sync(pull='--no-pull' not in sys.argv)
    sys.path.insert(0, CACHE)
    import earshot
    from earshot.forge import bank
    sounds = {}
    for event, (sid, offset) in KIT.items():
        y, meta = bank.render(sid)
        uri, dur, rms = encode(np.asarray(y, dtype=np.float64), meta.get('sr', 48000))
        sounds[event] = {'uri': uri, 'db': LEVEL + offset, 'src': sid, 'dur': round(dur, 3)}
        print(f'{event:9s} {sid:24s} {dur:.3f} s  rms {rms:6.1f} dB  plays at {rms + LEVEL + offset:6.1f} dB')
    kit = {'earshot': getattr(earshot, '__version__', ''), 'commit': commit, 'bank': getattr(bank, 'VERSION', ''),
           'sounds': sounds}
    with open(OUT, 'w') as f:
        json.dump(kit, f, indent=1)
        f.write('\n')
    print(f'earshot {kit["earshot"]} @ {commit[:12]} -> {os.path.relpath(OUT)} ({os.path.getsize(OUT) // 1024} KB)')


if __name__ == '__main__':
    main()
