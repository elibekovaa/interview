// Signaling server преподавателя
const SIGNALING_SERVER =
    "wss://inai-col3.fishrungames.com/signaling/";

// HTML элементы
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const statusText = document.getElementById("status");

const joinBtn = document.getElementById("joinBtn");
const micBtn = document.getElementById("micBtn");
const cameraBtn = document.getElementById("cameraBtn");
const leaveBtn = document.getElementById("leaveBtn");

// Переменные WebRTC
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let signalingSocket = null;

let myId = crypto.randomUUID();
let peerId = null;

let helloReceived = false;
let helloReplied = false;
let makingOffer = false;

let pendingCandidates = [];

// STUN-сервер для обнаружения сетевых адресов
const configuration = {
    iceServers: [{
        urls: "stun:stun.l.google.com:19302"
    }]
};



function updateStatus(message) {
    statusText.textContent = message;
}


function createPeerConnection() {

    if (peerConnection) return;

    peerConnection = new RTCPeerConnection(configuration);

    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;

    // Добавляем локальные аудио и видео дорожки
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Получаем видео и звук собеседника
    peerConnection.ontrack = event => {
        event.streams[0].getTracks().forEach(track => {
            remoteStream.addTrack(track);
        });
    };

    // Отправляем ICE Candidate через WebSocket
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            sendMessage({
                type: "candidate",
                candidate: event.candidate
            });
        }
    };

    // Отслеживаем состояние соединения
    peerConnection.onconnectionstatechange = () => {

        const state = peerConnection.connectionState;

        if (state === "connected") {
            updateStatus("Собеседник подключен");
        }

        if (state === "disconnected") {
            updateStatus("Соединение прервано");
        }

        if (state === "failed") {
            updateStatus("Ошибка соединения");
        }
    };
}



function sendMessage(message) {

    if (
        signalingSocket &&
        signalingSocket.readyState === WebSocket.OPEN
    ) {
        signalingSocket.send(JSON.stringify(message));
    }
}



async function createOffer() {

    if (!peerConnection || makingOffer) return;

    try {
        makingOffer = true;

        const offer = await peerConnection.createOffer();

        await peerConnection.setLocalDescription(offer);

        sendMessage({
            type: "offer",
            sdp: peerConnection.localDescription
        });

        updateStatus("Ожидание ответа собеседника...");

    } catch (error) {
        console.error("Ошибка создания Offer:", error);
        updateStatus("Ошибка создания звонка");
    } finally {
        makingOffer = false;
    }
}


async function handleOffer(message) {

    try {
        const offer = message.sdp || message.offer;

        if (!offer) return;

        await peerConnection.setRemoteDescription(offer);

        await processPendingCandidates();

        const answer = await peerConnection.createAnswer();

        await peerConnection.setLocalDescription(answer);

        sendMessage({
            type: "answer",
            sdp: peerConnection.localDescription
        });

        updateStatus("Отправлен ответ на звонок");

    } catch (error) {
        console.error("Ошибка обработки Offer:", error);
    }
}


async function handleAnswer(message) {

    try {
        const answer = message.sdp || message.answer;

        if (!answer) return;

        await peerConnection.setRemoteDescription(answer);

        await processPendingCandidates();

        updateStatus("Устанавливаем видеосвязь...");

    } catch (error) {
        console.error("Ошибка обработки Answer:", error);
    }
}



async function handleCandidate(message) {

    try {
        const candidate = message.candidate;

        if (!candidate) return;

        if (
            peerConnection.remoteDescription &&
            peerConnection.remoteDescription.type
        ) {
            await peerConnection.addIceCandidate(candidate);
        } else {
            pendingCandidates.push(candidate);
        }

    } catch (error) {
        console.error("Ошибка ICE Candidate:", error);
    }
}

// Добавление кандидатов, которые пришли раньше SDP
async function processPendingCandidates() {

    while (pendingCandidates.length > 0) {

        const candidate = pendingCandidates.shift();

        try {
            await peerConnection.addIceCandidate(candidate);
        } catch (error) {
            console.error("Ошибка добавления Candidate:", error);
        }
    }
}


async function handleMessage(event) {

    try {

        const message = JSON.parse(event.data);

        console.log("Получено сообщение:", message);

        switch (message.type) {

            case "hello":

                if (message.id === myId) return;

                peerId = message.id;
                helloReceived = true;

                // Отвечаем на приветствие один раз
                if (!helloReplied) {
                    helloReplied = true;

                    sendMessage({
                        type: "hello",
                        id: myId
                    });
                }

                updateStatus("Собеседник найден");

                // Только один участник создает Offer
                if (myId < peerId) {
                    await createOffer();
                }

                break;

            case "offer":
                await handleOffer(message);
                break;

            case "answer":
                await handleAnswer(message);
                break;

            case "candidate":
                await handleCandidate(message);
                break;

            case "peer-left":
                handlePeerLeft();
                break;

            default:
                console.log("Неизвестное сообщение:", message);
        }

    } catch (error) {
        console.error("Ошибка обработки сообщения:", error);
    }
}


function connectSignaling() {

    signalingSocket = new WebSocket(SIGNALING_SERVER);

    signalingSocket.onopen = () => {

        console.log("WebSocket подключен");

        updateStatus("Сервер подключен. Поиск собеседника...");

        sendMessage({
            type: "hello",
            id: myId
        });
    };

    signalingSocket.onmessage = handleMessage;

    signalingSocket.onerror = error => {
        console.error("Ошибка WebSocket:", error);
        updateStatus("Ошибка signaling-сервера");
    };

    signalingSocket.onclose = () => {

        console.log("WebSocket отключен");

        if (peerConnection || localStream) {
            updateStatus("Соединение с сервером потеряно");
        }
    };
}



async function joinCall() {

    try {

        updateStatus("Запрашиваем доступ к камере...");

        // Получаем камеру и микрофон
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        localVideo.srcObject = localStream;

        createPeerConnection();

        joinBtn.disabled = true;
        micBtn.disabled = false;
        cameraBtn.disabled = false;
        leaveBtn.disabled = false;

        connectSignaling();

    } catch (error) {

        console.error("Ошибка камеры или микрофона:", error);

        updateStatus("Не удалось получить доступ к камере");

        alert("Разрешите доступ к камере и микрофону в браузере.");

        cleanupCall();
    }
}


function handlePeerLeft() {

    updateStatus("Собеседник отключился");

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    remoteVideo.srcObject = null;
    remoteStream = null;
    peerId = null;
    helloReceived = false;
    helloReplied = false;
    makingOffer = false;
    pendingCandidates = [];
}


function toggleMicrophone() {

    if (!localStream) return;

    const audioTrack = localStream.getAudioTracks()[0];

    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;

    micBtn.textContent = audioTrack.enabled ?
        "Выключить микрофон" :
        "Включить микрофон";
}


function toggleCamera() {

    if (!localStream) return;

    const videoTrack = localStream.getVideoTracks()[0];

    if (!videoTrack) return;

    videoTrack.enabled = !videoTrack.enabled;

    cameraBtn.textContent = videoTrack.enabled ?
        "Выключить камеру" :
        "Включить камеру";
}

function cleanupCall() {

    if (signalingSocket) {
        signalingSocket.close();
        signalingSocket = null;
    }

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (remoteStream) {
        remoteStream = null;
    }

    localVideo.srcObject = null;
    remoteVideo.srcObject = null;

    peerId = null;
    helloReceived = false;
    helloReplied = false;
    makingOffer = false;
    pendingCandidates = [];

    micBtn.disabled = true;
    cameraBtn.disabled = true;
    leaveBtn.disabled = true;
    joinBtn.disabled = false;

    micBtn.textContent = "Выключить микрофон";
    cameraBtn.textContent = "Выключить камеру";

    updateStatus("Звонок завершен");
}


joinBtn.addEventListener("click", joinCall);

micBtn.addEventListener("click", toggleMicrophone);

cameraBtn.addEventListener("click", toggleCamera);

leaveBtn.addEventListener("click", cleanupCall);