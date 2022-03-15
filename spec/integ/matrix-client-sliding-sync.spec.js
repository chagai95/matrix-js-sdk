import { SlidingSync, SlidingSyncState } from "../../src/sliding-sync";
import { TestClient } from "../TestClient";

/**
 * Tests for sliding sync. These tests are broken down into sub-tests which are reliant upon one another.
 * Each test suite (describe block) uses a single MatrixClient/HTTPBackend and a single SlidingSync class.
 * Each test will call different functions on SlidingSync which may depend on state from previous tests.
 */
describe("SlidingSync", () => {
    let client = null;
    let httpBackend = null;
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";
    const proxyBaseUrl = "http://localhost:8008";
    const syncUrl = proxyBaseUrl + "/_matrix/client/unstable/org.matrix.msc3575/sync"

    // assign client/httpBackend globals
    const setupClient = () => {
        const testClient = new TestClient(selfUserId, "DEVICE", selfAccessToken);
        httpBackend = testClient.httpBackend;
        client = testClient.client;
    };

    // tear down client/httpBackend globals
    const teardownClient = () => {
        httpBackend.verifyNoOutstandingExpectation();
        client.stopClient();
        return httpBackend.stop();
    };

    describe("start/stop", () => {
        beforeAll(setupClient);
        afterAll(teardownClient);
        let slidingSync;

        it("should start the sync loop upon calling start()", async (done) => {
            slidingSync = new SlidingSync(proxyBaseUrl, [], {}, client, 1);
            const fakeResp = {
                pos: "a",
                ops: [],
                counts: [],
                room_subscriptions: {},
            };
            httpBackend.when("POST", syncUrl).respond(200, fakeResp);
            let p = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state, resp, err) => {
                expect(state).toEqual(SlidingSyncState.RequestFinished);
                expect(resp).toEqual(fakeResp);
                expect(err).toBeFalsy();
                return true;
            });
            slidingSync.start();
            await httpBackend.flushAllExpected();
            await p;
            done();
        });

        it("should stop the sync loop upon calling stop()", async (done) => {
            slidingSync.stop();
            httpBackend.verifyNoOutstandingExpectation();
            done();
        });
    });

    describe("room subscriptions", () => {
        beforeAll(setupClient);
        afterAll(teardownClient);
        const roomId = "!foo:bar";
        const anotherRoomID = "!another:room";
        let roomSubInfo = {
            timeline_limit: 1,
            required_state: [
                ["m.room.name", ""],
            ]
        };
        const wantRoomData = {
            name: "foo bar",
            room_id: roomId,
            required_state: [],
            timeline: [],
        };

        let slidingSync;

        it("should be able to subscribe to a room", async (done) => {    
            // add the subscription
            slidingSync = new SlidingSync(proxyBaseUrl, [], roomSubInfo, client, 1);
            slidingSync.modifyRoomSubscriptions(new Set([roomId]));
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log("room sub", body);
                expect(body.room_subscriptions).toBeTruthy();
                expect(body.room_subscriptions[roomId]).toEqual(roomSubInfo);
            }).respond(200, {
                pos: "a",
                ops: [],
                counts: [],
                room_subscriptions: {
                    [roomId]: wantRoomData
                },
            });

            let p = listenUntil(slidingSync, "SlidingSync.RoomData", (gotRoomId, gotRoomData) => {
                expect(gotRoomId).toEqual(roomId);
                expect(gotRoomData).toEqual(wantRoomData);
                return true;
            });
            slidingSync.start();
            await httpBackend.flushAllExpected();
            await p;
            done();
        });

        it("should be possible to adjust room subscription info whilst syncing", async (done) => {
            // listen for updated request
            const newSubInfo = {
                timeline_limit: 100,
                required_state: [
                    ["m.room.member", "*"],
                ]
            }
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log("adjusted sub", body);
                expect(body.room_subscriptions).toBeTruthy();
                expect(body.room_subscriptions[roomId]).toEqual(newSubInfo);
            }).respond(200, {
                pos: "a",
                ops: [],
                counts: [],
                room_subscriptions: {
                    [roomId]: wantRoomData
                },
            });

            let p = listenUntil(slidingSync, "SlidingSync.RoomData", (gotRoomId, gotRoomData) => {
                expect(gotRoomId).toEqual(roomId);
                expect(gotRoomData).toEqual(wantRoomData);
                return true;
            });
            
            slidingSync.modifyRoomSubscriptionInfo(newSubInfo);
            await httpBackend.flushAllExpected();
            await p;
            // need to set what the new subscription info is for subsequent tests
            roomSubInfo = newSubInfo;
            done();
        });

        it("should be possible to add room subscriptions whilst syncing", async (done) => {
            // listen for updated request
            const anotherRoomData = {
                name: "foo bar 2",
                room_id: anotherRoomID,
                required_state: [],
                timeline: [],
            }
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log("new subs", body);
                expect(body.room_subscriptions).toBeTruthy();
                // only the new room is sent, the other is sticky
                expect(body.room_subscriptions[anotherRoomID]).toEqual(roomSubInfo);
                expect(body.room_subscriptions[roomId]).toBeUndefined();
            }).respond(200, {
                pos: "b",
                ops: [],
                counts: [],
                room_subscriptions: {
                    [anotherRoomID]: anotherRoomData
                },
            });

            let p = listenUntil(slidingSync, "SlidingSync.RoomData", (gotRoomId, gotRoomData) => {
                expect(gotRoomId).toEqual(anotherRoomID);
                expect(gotRoomData).toEqual(anotherRoomData);
                return true;
            });
            
            const subs = slidingSync.getRoomSubscriptions();
            subs.add(anotherRoomID);
            slidingSync.modifyRoomSubscriptions(subs);
            await httpBackend.flushAllExpected();
            await p;
            done();
        });

        it("should be able to unsubscribe from a room", async (done) => {
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log("unsub request", body);
                expect(body.room_subscriptions).toBeFalsy();
                expect(body.unsubscribe_rooms).toEqual([roomId]);
            }).respond(200, {
                pos: "b",
                ops: [],
                counts: []
            });
        
            let p = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            });
        
            // remove the subscription for the first room
            slidingSync.modifyRoomSubscriptions(new Set([anotherRoomID]));
        
            await httpBackend.flushAllExpected();
            await p;

            slidingSync.stop();
            done();
        });
    });

    xdescribe("lists", () => {
        beforeAll(setupClient);
        afterAll(teardownClient);
        it("should be possible to subscribe to a list", async (done) => {
            // request first 3 rooms
            let listReq = {
                ranges:  [[0,2]],
                sort: ["by_name"],
                timeline_limit: 1,
                required_state: [
                    ["m.room.topic", ""],
                ],
                filters: {
                    is_dm: true,
                },
            };
            const slidingSync = new SlidingSync(proxyBaseUrl, [listReq], {}, client, 1);
            const roomA = "!a:localhost";
            const roomB = "!b:localhost";
            const roomC = "!c:localhost";
            const rooms = [
                {
                    room_id: roomA,
                    name: "A",
                    required_state: [],
                    timeline: [],
                },
                {
                    room_id: roomB,
                    name: "B",
                    required_state: [],
                    timeline: [],
                },
                {
                    room_id: roomC,
                    name: "C",
                    required_state: [],
                    timeline: [],
                },
            ]
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log(body);
                expect(body.lists).toBeTruthy();
                expect(body.lists[0]).toEqual(listReq);
            }).respond(200, {
                pos: "a",
                ops: [{
                    op: "SYNC",
                    list: 0,
                    range: [0,2],
                    rooms: rooms,
                }],
                counts: [500],
            });
            let listenerData = {};
            slidingSync.on("SlidingSync.RoomData", (roomId, roomData) => {
                expect(listenerData[roomId]).toBeFalsy();
                listenerData[roomId] = roomData;
            });
            let responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            })
            slidingSync.start();
            await httpBackend.flushAllExpected();
            await responseProcessed;

            expect(listenerData[roomA]).toEqual(rooms[0]);
            expect(listenerData[roomB]).toEqual(rooms[1]);
            expect(listenerData[roomC]).toEqual(rooms[2]);
            slidingSync.stop();
            done();
        });

        it("should be possible to adjust list ranges", async (done) => {
            // make 1 list, modify range, check it gets submitted
            let listReq = {
                ranges:  [[0,2]],
                sort: ["by_name"],
                timeline_limit: 1,
                required_state: [
                    ["m.room.topic", ""],
                ],
                filters: {
                    is_dm: true,
                },
            };
            const slidingSync = new SlidingSync(proxyBaseUrl, [listReq], {}, client, 1);
            const roomA = "!a:localhost";
            const roomB = "!b:localhost";
            const roomC = "!c:localhost";
            const rooms = [
                {
                    room_id: roomA,
                    name: "A",
                    required_state: [],
                    timeline: [],
                },
                {
                    room_id: roomB,
                    name: "B",
                    required_state: [],
                    timeline: [],
                },
                {
                    room_id: roomC,
                    name: "C",
                    required_state: [],
                    timeline: [],
                },
            ]
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log(body);
                expect(body.lists).toBeTruthy();
                expect(body.lists[0]).toEqual(listReq);
            }).respond(200, {
                pos: "a",
                ops: [{
                    op: "SYNC",
                    list: 0,
                    range: [0,2],
                    rooms: rooms,
                }],
                counts: [500],
            });
            let responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            })
            slidingSync.start();
            await httpBackend.flushAllExpected();
            await responseProcessed;
            // TODO: the above is duped from test 'should be possible to subscribe to a list'

            // modify the list and list for the new request
            let newRanges =  [[0,2],[3,5]];
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log("next ranges", body.lists[0].ranges);
                expect(body.lists).toBeTruthy();
                expect(body.lists[0]).toEqual({
                    // only the ranges should be sent as the rest are unchanged and sticky
                    ranges: newRanges,
                });
            }).respond(200, {
                pos: "b",
                ops: [{
                    op: "SYNC",
                    list: 0,
                    range: [0,2],
                    rooms: rooms,
                }],
                counts: [500],
            });
            
            slidingSync.setListRanges(0, newRanges);
            responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.RequestFinished;
            });
            await httpBackend.flushAllExpected();
            await responseProcessed;


            slidingSync.stop();
            done();
        });

        it("should be possible to get list updates", () => {
            // make 2 lists, issue INSERT, check right one gets updated with right values
        });

    });
});

function timeout(delayMs, reason) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(`timeout: ${delayMs}ms - ${reason}`);
        }, delayMs);
    });
}

/**
 * Listen until a callback returns data.
 * @param {EventEmitter} emitter The event emitter
 * @param {string} eventName The event to listen for
 * @param {function} callback The callback which will be invoked when events fire. Return something truthy from this to resolve the promise.
 * @param {number} timeoutMs The number of milliseconds to wait for the callback to return data. Default: 500ms.
 * @returns A promise which will be resolved when the callback returns data. If the callback throws or the timeout is reached,
 * the promise is rejected.
 */
function listenUntil(emitter, eventName, callback, timeoutMs) {
    if (!timeoutMs) {
        timeoutMs = 500;
    }
    const trace = new Error().stack.split(`\n`)[2];
    return Promise.race([new Promise((resolve, reject) => {
        const wrapper = (...args) => {
            try {
                const data = callback(...args)
                if (data) {
                    emitter.off(eventName, wrapper);
                    resolve(data);
                }
            } catch (err) {
                reject(err);
            }
        }
        emitter.on(eventName, wrapper);
    }), timeout(timeoutMs, "timed out waiting for event " + eventName + " " + trace)]);
}