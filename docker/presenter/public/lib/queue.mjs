/**
 * A small work queue. At most `limit` jobs run at once.
 * Later jobs wait until a slot is free.
 */

export function createQueue(limit = 2) {
    let active = 0;
    const waiting = [];

    function pump() {
        while (active < limit && waiting.length) {
            const job = waiting.shift();
            active += 1;
            Promise.resolve()
                .then(job.run)
                .then(job.resolve, job.reject)
                .finally(() => {
                    active -= 1;
                    pump();
                });
        }
    }

    return {
        get active() {
            return active;
        },
        enqueue(run) {
            return new Promise((resolve, reject) => {
                waiting.push({ run, resolve, reject });
                pump();
            });
        },
    };
}
