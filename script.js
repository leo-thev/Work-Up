/* =========================================================
   WORK UP — SCRIPT PRINCIPAL
   ========================================================= */


/* =========================================================
   LOCAL STORAGE
   ========================================================= */

const supabaseClient = window.supabase.createClient(
    window.WORK_UP_SUPABASE.url,
    window.WORK_UP_SUPABASE.anonKey
);

let currentAccount = null;
let remoteData = {};
let remoteSyncQueue = Promise.resolve();

document.body.classList.add("auth-checking");

function getScopedStorageKey(key) {
    return currentAccount
        ? `workUp:${currentAccount.id}:${key}`
        : `workUp:unauthenticated:${key}`;
}

function getAccountFromUser(user) {
    if (!user) {
        return null;
    }

    return {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.display_name || user.email
    };
}

function getCachedSupabaseUser() {
    try {
        const projectRef = new URL(window.WORK_UP_SUPABASE.url).hostname.split(".")[0];
        const storedSession = localStorage.getItem(`sb-${projectRef}-auth-token`);
        const session = storedSession ? JSON.parse(storedSession) : null;
        return session?.user || null;
    } catch (error) {
        return null;
    }
}

currentAccount = getAccountFromUser(getCachedSupabaseUser());

const authOverlay = document.getElementById("authOverlay");
const authForm = document.getElementById("authForm");
const authNameField = document.getElementById("authNameField");
const authNameInput = document.getElementById("authName");
const authEmailInput = document.getElementById("authEmail");
const authPasswordInput = document.getElementById("authPassword");
const passwordToggle = document.getElementById("passwordToggle");
const authError = document.getElementById("authError");
const authTitle = document.getElementById("authTitle");
const authDescription = document.getElementById("authDescription");
const authSubmit = document.getElementById("authSubmit");
const authSwitch = document.getElementById("authSwitch");
const accountName = document.getElementById("accountName");
const logoutButton = document.getElementById("logoutButton");

let isRegistering = false;

function showAuthError(message) {
    authError.textContent = message;
}

function updateAuthMode() {
    isRegistering = !isRegistering;
    authNameField.hidden = !isRegistering;
    authNameInput.required = isRegistering;
    authTitle.textContent = isRegistering ? "Créer ton compte" : "Connexion";
    authDescription.textContent = isRegistering
        ? "Un espace personnel pour tes tâches, habitudes et sessions."
        : "Retrouve tes tâches et habitudes sur ton espace.";
    authSubmit.textContent = isRegistering ? "Créer mon compte" : "Se connecter";
    authSwitch.textContent = isRegistering ? "J'ai déjà un compte" : "Créer un compte";
    authPasswordInput.autocomplete = isRegistering ? "new-password" : "current-password";
    showAuthError("");
}

function getAuthRedirectUrl() {
    if (!window.location.protocol.startsWith("http")) {
        return null;
    }

    return `${window.location.origin}${window.location.pathname}`;
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    showAuthError("");
    authSubmit.disabled = true;

    try {
        const email = authEmailInput.value.trim().toLowerCase();
        const password = authPasswordInput.value;
        const redirectUrl = getAuthRedirectUrl();
        const signUpOptions = {
            data: {
                display_name: authNameInput.value.trim()
            }
        };

        if (redirectUrl) {
            signUpOptions.emailRedirectTo = redirectUrl;
        }

        const authResult = isRegistering
            ? await supabaseClient.auth.signUp({
                email,
                password,
                options: signUpOptions
            })
            : await supabaseClient.auth.signInWithPassword({ email, password });

        if (authResult.error) {
            throw authResult.error;
        }

        if (isRegistering && !authResult.data.session) {
            showAuthError("Compte créé. Vérifie ton e-mail avant de te connecter.");
            authSubmit.disabled = false;
            return;
        }

        window.location.reload();
    } catch (error) {
        showAuthError(error.message);
        authSubmit.disabled = false;
    }
}

if (authForm) {
    authForm.addEventListener("submit", handleAuthSubmit);
    authSwitch.addEventListener("click", updateAuthMode);
}

if (passwordToggle) {
    passwordToggle.addEventListener("click", () => {
        const isVisible = authPasswordInput.type === "text";
        authPasswordInput.type = isVisible ? "password" : "text";
        passwordToggle.textContent = isVisible ? "Afficher" : "Masquer";
        passwordToggle.setAttribute(
            "aria-label",
            isVisible ? "Afficher le mot de passe" : "Masquer le mot de passe"
        );
        passwordToggle.setAttribute("aria-pressed", String(!isVisible));
    });
}

if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
        await remoteSyncQueue;
        await supabaseClient.auth.signOut();
        window.location.reload();
    });
}

async function hydrateRemoteData() {
    const { data, error } = await supabaseClient
        .from("user_data")
        .select("data")
        .eq("user_id", currentAccount.id)
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data || !data.data || Object.keys(data.data).length === 0) {
        remoteData = {};

        getAllAppStorageKeys().forEach(key => {
            const cachedValue = localStorage.getItem(getScopedStorageKey(key));

            if (cachedValue !== null) {
                remoteData[key] = JSON.parse(cachedValue);
            }
        });

        if (Object.keys(remoteData).length > 0) {
            const { error: migrationError } = await supabaseClient
                .from("user_data")
                .upsert({
                    user_id: currentAccount.id,
                    data: remoteData,
                    updated_at: new Date().toISOString()
                });

            if (migrationError) {
                throw migrationError;
            }
        }
    } else {
        remoteData = data.data || {};
    }
    let cacheNeedsReload = false;

    Object.entries(remoteData).forEach(([key, value]) => {
        const serializedValue = JSON.stringify(value);

        if (localStorage.getItem(getScopedStorageKey(key)) !== serializedValue) {
            cacheNeedsReload = true;
        }

        localStorage.setItem(
            getScopedStorageKey(key),
            serializedValue
        );
    });

    return cacheNeedsReload;
}

async function initializeAuthentication() {
    try {
        const { data, error } = await supabaseClient.auth.getSession();

        if (error) {
            throw error;
        }

        if (!data.session) {
            document.body.classList.remove("auth-checking");
            document.body.classList.add("auth-locked");
            return;
        }

        currentAccount = getAccountFromUser(data.session.user);
        const cacheNeedsReload = await hydrateRemoteData();
        accountName.textContent = currentAccount.name;
        authOverlay.hidden = true;

        if (cacheNeedsReload) {
            window.location.reload();
            return;
        }

        document.body.classList.remove("auth-checking", "auth-locked");
    } catch (error) {
        document.body.classList.remove("auth-checking");
        document.body.classList.add("auth-locked");
        showAuthError(`Connexion Supabase impossible : ${error.message}`);
    }
}

initializeAuthentication();

const STORAGE_KEYS = {
    tasks: "workUpTasks",
    habits: "workUpHabits",
    completions: "workUpHabitCompletions",
    revisionSheets: "workUpRevisionSheets"
};


/* =========================================================
   DONNÉES
   ========================================================= */

let tasks = loadStorage(STORAGE_KEYS.tasks, []);

let habits = loadStorage(STORAGE_KEYS.habits, []);

let habitCompletions =
    loadStorage(STORAGE_KEYS.completions, {});

let revisionSheets =
    loadStorage(STORAGE_KEYS.revisionSheets, []);

let activeRevisionSheetId = null;


/* =========================================================
   UTILITAIRES STORAGE
   ========================================================= */

function loadStorage(key, fallback) {

    try {

        const saved = localStorage.getItem(getScopedStorageKey(key));

        return saved
            ? JSON.parse(saved)
            : fallback;

    } catch (error) {

        console.error(
            `Impossible de charger ${key}`,
            error
        );

        return fallback;
    }
}


function saveStorage(key, value) {

    try {

        localStorage.setItem(
            getScopedStorageKey(key),
            JSON.stringify(value)
        );

        return syncRemoteStorage(key, value);

    } catch (error) {

        console.error(
            `Impossible de sauvegarder ${key}`,
            error
        );
    }
}

async function syncRemoteStorage(key, value) {
    if (!currentAccount) {
        return;
    }

    remoteData[key] = value;

    const dataSnapshot = structuredClone(remoteData);

    remoteSyncQueue = remoteSyncQueue
        .then(async () => {
            const { error } = await supabaseClient
                .from("user_data")
                .upsert({
                    user_id: currentAccount.id,
                    data: dataSnapshot,
                    updated_at: new Date().toISOString()
                });

            if (error) {
                throw error;
            }
        })
        .catch(error => {
            console.error("Impossible de synchroniser les données", error);

            if (settingsSaveStatus) {
                settingsSaveStatus.textContent =
                    "Erreur : données non synchronisées.";
            }
        });

    return remoteSyncQueue;
}


/* =========================================================
   NAVIGATION PRINCIPALE
   ========================================================= */

const navItems =
    document.querySelectorAll(".nav-item");

const views =
    document.querySelectorAll(".view");


navItems.forEach(button => {

    button.addEventListener("click", () => {

        const targetId =
            button.dataset.view;


        /* Retirer active de tous les boutons */

        navItems.forEach(item => {
            item.classList.remove("active");
        });


        /* Activer le bouton */

        button.classList.add("active");


        /* Changer de vue */

        views.forEach(view => {

            view.classList.remove("active");

            if (view.id === targetId) {
                view.classList.add("active");
            }

        });


        /* Rafraîchir les habitudes si nécessaire */

        if (targetId === "habitsView") {
            renderHabits(false);
        }

        if (targetId === "revisionView") {
            renderRevisionSheets();
        }

    });

});

/* =========================================================
   FICHES DE RÉVISION
   ========================================================= */

const revisionSheetList =
    document.getElementById("revisionSheetList");

const revisionSheetCount =
    document.getElementById("revisionSheetCount");

const revisionEmptyList =
    document.getElementById("revisionEmptyList");

const revisionEditorEmpty =
    document.getElementById("revisionEditorEmpty");

const revisionEditorContent =
    document.getElementById("revisionEditorContent");

const revisionTitleInput =
    document.getElementById("revisionTitleInput");

const revisionSubjectInput =
    document.getElementById("revisionSubjectInput");

const revisionSections =
    document.getElementById("revisionSections");

const revisionSaveStatus =
    document.getElementById("revisionSaveStatus");

function createRevisionId() {
    return typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `revision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createRevisionSection(title = "Nouvelle sous-section") {
    return {
        id: createRevisionId(),
        title,
        content: ""
    };
}

function createRevisionSheet() {
    const sheet = {
        id: createRevisionId(),
        title: "Nouvelle fiche",
        subject: "",
        sections: [createRevisionSection("Résumé")],
        updatedAt: Date.now()
    };

    revisionSheets.unshift(sheet);
    activeRevisionSheetId = sheet.id;
    saveStorage(STORAGE_KEYS.revisionSheets, revisionSheets);
    renderRevisionSheets();
}

function getActiveRevisionSheet() {
    return revisionSheets.find(
        sheet => sheet.id === activeRevisionSheetId
    );
}

function saveRevisionSheets() {
    const activeSheet = getActiveRevisionSheet();

    if (activeSheet) {
        activeSheet.updatedAt = Date.now();
    }

    saveStorage(STORAGE_KEYS.revisionSheets, revisionSheets);

    if (revisionSaveStatus) {
        revisionSaveStatus.textContent = "Enregistrée automatiquement";
    }
}

function updateRevisionEditor() {
    const sheet = getActiveRevisionSheet();

    if (!sheet) {
        revisionEditorEmpty.hidden = false;
        revisionEditorContent.hidden = true;
        return;
    }

    revisionEditorEmpty.hidden = true;
    revisionEditorContent.hidden = false;
    revisionTitleInput.value = sheet.title;
    revisionSubjectInput.value = sheet.subject || "";
    revisionSections.innerHTML = "";

    sheet.sections.forEach((section, index) => {
        const sectionElement = document.createElement("article");
        sectionElement.className = "revision-section";

        const sectionHeader = document.createElement("div");
        sectionHeader.className = "revision-section-header";

        const sectionNumber = document.createElement("span");
        sectionNumber.className = "revision-section-number";
        sectionNumber.textContent = String(index + 1).padStart(2, "0");

        const sectionTitle = document.createElement("input");
        sectionTitle.className = "revision-section-title";
        sectionTitle.type = "text";
        sectionTitle.maxLength = 100;
        sectionTitle.value = section.title;
        sectionTitle.placeholder = "Titre de la sous-section";

        const deleteSection = document.createElement("button");
        deleteSection.className = "delete-revision-section";
        deleteSection.type = "button";
        deleteSection.textContent = "Supprimer";
        deleteSection.addEventListener("click", () => {
            if (sheet.sections.length === 1) {
                return;
            }

            sheet.sections = sheet.sections.filter(
                currentSection => currentSection.id !== section.id
            );
            saveRevisionSheets();
            updateRevisionEditor();
        });

        sectionHeader.append(sectionNumber, sectionTitle, deleteSection);

        const sectionContent = document.createElement("textarea");
        sectionContent.className = "revision-section-content";
        sectionContent.rows = 6;
        sectionContent.value = section.content || "";
        sectionContent.placeholder = "Écris ici les notions, définitions, exemples ou questions à retenir...";

        sectionTitle.addEventListener("input", () => {
            section.title = sectionTitle.value;
            saveRevisionSheets();
        });

        sectionContent.addEventListener("input", () => {
            section.content = sectionContent.value;
            saveRevisionSheets();
        });

        sectionElement.append(sectionHeader, sectionContent);
        revisionSections.appendChild(sectionElement);
    });
}

function renderRevisionSheets() {
    revisionSheetList.innerHTML = "";
    revisionSheetCount.textContent = revisionSheets.length;
    revisionEmptyList.hidden = revisionSheets.length > 0;

    if (
        !activeRevisionSheetId &&
        revisionSheets.length > 0
    ) {
        activeRevisionSheetId = revisionSheets[0].id;
    }

    revisionSheets.forEach(sheet => {
        const item = document.createElement("button");
        item.className = "revision-sheet-item";
        item.type = "button";
        item.classList.toggle(
            "active",
            sheet.id === activeRevisionSheetId
        );

        const title = document.createElement("strong");
        title.textContent = sheet.title || "Fiche sans titre";

        const subject = document.createElement("span");
        subject.textContent = sheet.subject || "Sans matière";

        item.append(title, subject);
        item.addEventListener("click", () => {
            activeRevisionSheetId = sheet.id;
            renderRevisionSheets();
        });
        revisionSheetList.appendChild(item);
    });

    updateRevisionEditor();
}

function updateActiveRevisionMetadata() {
    const sheet = getActiveRevisionSheet();

    if (!sheet) {
        return;
    }

    sheet.title = revisionTitleInput.value.trim() || "Fiche sans titre";
    sheet.subject = revisionSubjectInput.value.trim();
    saveRevisionSheets();

    const activeItem = revisionSheetList.querySelector(".revision-sheet-item.active strong");

    if (activeItem) {
        activeItem.textContent = sheet.title;
    }
}

revisionTitleInput.addEventListener("input", updateActiveRevisionMetadata);
revisionSubjectInput.addEventListener("input", updateActiveRevisionMetadata);

document.getElementById("createRevisionSheet").addEventListener(
    "click",
    createRevisionSheet
);

document.getElementById("createRevisionSheetEmpty").addEventListener(
    "click",
    createRevisionSheet
);

document.getElementById("addRevisionSection").addEventListener(
    "click",
    () => {
        const sheet = getActiveRevisionSheet();

        if (!sheet) {
            return;
        }

        sheet.sections.push(createRevisionSection());
        saveRevisionSheets();
        updateRevisionEditor();
    }
);

document.getElementById("deleteRevisionSheet").addEventListener(
    "click",
    () => {
        if (!activeRevisionSheetId) {
            return;
        }

        openModal(revisionDeleteConfirmOverlay);
    }
);

const revisionDeleteConfirmOverlay =
    document.getElementById("revisionDeleteConfirmOverlay");

const closeRevisionDeleteConfirm =
    document.getElementById("closeRevisionDeleteConfirm");

const cancelRevisionDeleteConfirm =
    document.getElementById("cancelRevisionDeleteConfirm");

const confirmRevisionDelete =
    document.getElementById("confirmRevisionDelete");

function closeRevisionDeleteModal() {
    closeModal(revisionDeleteConfirmOverlay);
}

closeRevisionDeleteConfirm.addEventListener(
    "click",
    closeRevisionDeleteModal
);

cancelRevisionDeleteConfirm.addEventListener(
    "click",
    closeRevisionDeleteModal
);

confirmRevisionDelete.addEventListener(
    "click",
    () => {
        revisionSheets = revisionSheets.filter(
            sheet => sheet.id !== activeRevisionSheetId
        );
        activeRevisionSheetId = revisionSheets[0]?.id || null;
        saveStorage(STORAGE_KEYS.revisionSheets, revisionSheets);
        renderRevisionSheets();
        closeRevisionDeleteModal();
    }
);

revisionDeleteConfirmOverlay.addEventListener(
    "click",
    event => {
        if (event.target === revisionDeleteConfirmOverlay) {
            closeRevisionDeleteModal();
        }
    }
);

/* =========================================================
   PARAMÈTRES
   ========================================================= */

const SETTINGS_STORAGE_KEY = "workUpSettings";

const reducedMotionSetting =
    document.getElementById("reducedMotionSetting");

const densitySetting =
    document.getElementById("densitySetting");

const notificationsSetting =
    document.getElementById("notificationsSetting");

const confirmDeleteSetting =
    document.getElementById("confirmDeleteSetting");

const resetSettingsButton =
    document.getElementById("resetSettings");

const clearAppDataButton =
    document.getElementById("clearAppData");

const exportAppDataButton =
    document.getElementById("exportAppData");

const importAppDataButton =
    document.getElementById("importAppData");

const importAppDataFile =
    document.getElementById("importAppDataFile");

const settingsSaveStatus =
    document.getElementById("settingsSaveStatus");

const defaultSettings = {
    reducedMotion: false,
    density: "comfortable",
    notifications: false,
    confirmDelete: true
};

let appSettings = {
    ...defaultSettings,
    ...loadStorage(
        SETTINGS_STORAGE_KEY,
        {}
    )
};


function saveAppSettings() {

    saveStorage(
        SETTINGS_STORAGE_KEY,
        appSettings
    );

    if (settingsSaveStatus) {
        settingsSaveStatus.textContent =
            "Préférences enregistrées.";
    }

}


function applyAppSettings() {

    document.body.classList.toggle(
        "reduced-motion",
        appSettings.reducedMotion
    );

    document.body.classList.toggle(
        "compact-mode",
        appSettings.density === "compact"
    );

    if (reducedMotionSetting) {
        reducedMotionSetting.checked = appSettings.reducedMotion;
    }

    if (densitySetting) {
        densitySetting.value = appSettings.density;
    }

    if (notificationsSetting) {
        notificationsSetting.checked = appSettings.notifications;
    }

    if (confirmDeleteSetting) {
        confirmDeleteSetting.checked = appSettings.confirmDelete;
    }

}


function updateSetting(key, value) {

    appSettings[key] = value;
    saveAppSettings();
    applyAppSettings();

}


if (reducedMotionSetting) {
    reducedMotionSetting.addEventListener(
        "change",
        () => updateSetting(
            "reducedMotion",
            reducedMotionSetting.checked
        )
    );
}

if (densitySetting) {
    densitySetting.addEventListener(
        "change",
        () => updateSetting(
            "density",
            densitySetting.value
        )
    );
}

if (notificationsSetting) {
    notificationsSetting.addEventListener(
        "change",
        () => updateSetting(
            "notifications",
            notificationsSetting.checked
        )
    );
}

if (confirmDeleteSetting) {
    confirmDeleteSetting.addEventListener(
        "change",
        () => updateSetting(
            "confirmDelete",
            confirmDeleteSetting.checked
        )
    );
}

if (resetSettingsButton) {
    resetSettingsButton.addEventListener(
        "click",
        () => {
            appSettings = { ...defaultSettings };
            saveAppSettings();
            applyAppSettings();
        }
    );
}

if (clearAppDataButton) {
    clearAppDataButton.addEventListener(
        "click",
        async () => {
            const confirmed = window.confirm(
                "Effacer toutes les tâches, habitudes, sessions et préférences ?"
            );

            if (!confirmed) {
                return;
            }

            await remoteSyncQueue;

            const { error } = await supabaseClient
                .from("user_data")
                .delete()
                .eq("user_id", currentAccount.id);

            if (error) {
                window.alert(`Suppression impossible : ${error.message}`);
                return;
            }

            remoteData = {};

            [
                ...Object.values(STORAGE_KEYS),
                FOCUS_STORAGE_KEY,
                WHEEL_STORAGE_KEY,
                PRIORITIES_STORAGE_KEY,
                PLANNING_STORAGE_KEY,
                SETTINGS_STORAGE_KEY,
                INBOX_STORAGE_KEY
            ].forEach(key => localStorage.removeItem(getScopedStorageKey(key)));

            window.location.reload();
        }
    );
}

function getAllAppStorageKeys() {
    return [
        ...Object.values(STORAGE_KEYS),
        FOCUS_STORAGE_KEY,
        WHEEL_STORAGE_KEY,
        PRIORITIES_STORAGE_KEY,
        PLANNING_STORAGE_KEY,
        SETTINGS_STORAGE_KEY,
        INBOX_STORAGE_KEY
    ];
}

if (exportAppDataButton) {
    exportAppDataButton.addEventListener("click", () => {
        const data = {};

        getAllAppStorageKeys().forEach(key => {
            const value = localStorage.getItem(getScopedStorageKey(key));

            if (value !== null) {
                data[key] = JSON.parse(value);
            }
        });

        const exportFile = new Blob(
            [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data }, null, 2)],
            { type: "application/json" }
        );
        const downloadUrl = URL.createObjectURL(exportFile);
        const downloadLink = document.createElement("a");

        downloadLink.href = downloadUrl;
        downloadLink.download = `work-up-${currentAccount.id}-backup.json`;
        downloadLink.click();
        URL.revokeObjectURL(downloadUrl);
    });
}

if (importAppDataButton && importAppDataFile) {
    importAppDataButton.addEventListener("click", () => {
        importAppDataFile.click();
    });

    importAppDataFile.addEventListener("change", async () => {
        const [file] = importAppDataFile.files;

        if (!file) {
            return;
        }

        try {
            const backup = JSON.parse(await file.text());
            const allowedKeys = new Set(getAllAppStorageKeys());

            if (!backup || backup.version !== 1 || !backup.data) {
                throw new Error("Format de sauvegarde non reconnu.");
            }

            Object.entries(backup.data).forEach(([key, value]) => {
                if (allowedKeys.has(key)) {
                    localStorage.setItem(
                        getScopedStorageKey(key),
                        JSON.stringify(value)
                    );
                }
            });

            window.location.reload();
        } catch (error) {
            window.alert(`Import impossible : ${error.message}`);
        } finally {
            importAppDataFile.value = "";
        }
    });
}

applyAppSettings();


/* =========================================================
   MODAL GÉNÉRIQUE
   ========================================================= */

function openModal(modal) {

    if (!modal) return;

    modal.classList.add("active");

}


function closeModal(modal) {

    if (!modal) return;

    modal.classList.remove("active");

}


/* =========================================================
   MODAL TÂCHE
   ========================================================= */

const taskModalOverlay =
    document.getElementById("taskModalOverlay");

const openTaskModalButton =
    document.getElementById("openTaskModal");

const closeTaskModalButton =
    document.getElementById("closeTaskModal");

const cancelTaskModalButton =
    document.getElementById("cancelTaskModal");

const taskForm =
    document.getElementById("taskForm");

const taskNameInput =
    document.getElementById("taskName");

const taskUrgencyInput =
    document.getElementById("taskUrgency");

const taskDetailsModalOverlay =
    document.getElementById("taskDetailsModalOverlay");

const closeTaskDetailsButton =
    document.getElementById("closeTaskDetailsModal");

const cancelTaskDetailsButton =
    document.getElementById("cancelTaskDetails");

const taskDetailsForm =
    document.getElementById("taskDetailsForm");

const taskDetailsNameInput =
    document.getElementById("taskDetailsName");

const taskDetailsUrgencyInput =
    document.getElementById("taskDetailsUrgency");

const taskDetailsDescriptionInput =
    document.getElementById("taskDetailsDescription");

const taskDetailsTagsInput =
    document.getElementById("taskDetailsTags");

const taskDetailsSubtasksInput =
    document.getElementById("taskDetailsSubtasks");

let taskBeingEdited = null;


function openTaskDetails(task) {

    taskBeingEdited = task;

    taskDetailsNameInput.value = task.name;
    taskDetailsUrgencyInput.value = task.urgency;
    taskDetailsDescriptionInput.value = task.description || "";
    taskDetailsTagsInput.value = Array.isArray(task.tags)
        ? task.tags.join(", ")
        : task.tags || "";
    taskDetailsSubtasksInput.value = Array.isArray(task.subtasks)
        ? task.subtasks.map(subtask =>
            typeof subtask === "string" ? subtask : subtask.text
        ).join("\n")
        : task.subtasks || "";

    openModal(taskDetailsModalOverlay);

    setTimeout(() => {
        taskDetailsNameInput.focus();
    }, 100);

}


function closeTaskDetails() {

    taskBeingEdited = null;
    closeModal(taskDetailsModalOverlay);

}


closeTaskDetailsButton.addEventListener(
    "click",
    closeTaskDetails
);


cancelTaskDetailsButton.addEventListener(
    "click",
    closeTaskDetails
);


taskDetailsModalOverlay.addEventListener(
    "click",
    event => {

        if (event.target === taskDetailsModalOverlay) {
            closeTaskDetails();
        }

    }
);


taskDetailsForm.addEventListener(
    "submit",
    event => {

        event.preventDefault();

        if (!taskBeingEdited) return;

        const name = taskDetailsNameInput.value.trim();

        if (!name) return;

        taskBeingEdited.name = name;
        taskBeingEdited.urgency = taskDetailsUrgencyInput.value;
        taskBeingEdited.description = taskDetailsDescriptionInput.value.trim();
        taskBeingEdited.tags = taskDetailsTagsInput.value
            .split(",")
            .map(tag => tag.trim())
            .filter(Boolean);
        taskBeingEdited.subtasks = taskDetailsSubtasksInput.value
            .split("\n")
            .map(subtask => subtask.trim())
            .filter(Boolean);

        saveStorage(
            STORAGE_KEYS.tasks,
            tasks
        );

        renderTasks();
        closeTaskDetails();

    }
);

const deleteConfirmModalOverlay =
    document.getElementById("deleteConfirmModalOverlay");

const closeDeleteConfirmButton =
    document.getElementById("closeDeleteConfirmModal");

const cancelDeleteConfirmButton =
    document.getElementById("cancelDeleteConfirm");

const confirmDeleteTaskButton =
    document.getElementById("confirmDeleteTask");

let taskPendingDeletion = null;


function deleteTask(task) {

    tasks =
        tasks.filter(
            currentTask =>
                currentTask.id !== task.id
        );

    saveStorage(
        STORAGE_KEYS.tasks,
        tasks
    );

    renderTasks();

}


function requestTaskDeletion(task) {

    if (!appSettings.confirmDelete) {
        deleteTask(task);
        return;
    }

    taskPendingDeletion = task;
    openModal(deleteConfirmModalOverlay);

}


function closeDeleteConfirmation() {

    taskPendingDeletion = null;
    closeModal(deleteConfirmModalOverlay);

}


closeDeleteConfirmButton.addEventListener(
    "click",
    closeDeleteConfirmation
);


cancelDeleteConfirmButton.addEventListener(
    "click",
    closeDeleteConfirmation
);


confirmDeleteTaskButton.addEventListener(
    "click",
    () => {

        if (taskPendingDeletion) {
            deleteTask(taskPendingDeletion);
        }

        closeDeleteConfirmation();

    }
);


deleteConfirmModalOverlay.addEventListener(
    "click",
    event => {

        if (event.target === deleteConfirmModalOverlay) {
            closeDeleteConfirmation();
        }

    }
);


openTaskModalButton.addEventListener(
    "click",
    () => {

        openModal(taskModalOverlay);

        setTimeout(() => {
            taskNameInput.focus();
        }, 100);

    }
);


closeTaskModalButton.addEventListener(
    "click",
    () => {
        closeModal(taskModalOverlay);
    }
);


cancelTaskModalButton.addEventListener(
    "click",
    () => {
        closeModal(taskModalOverlay);
    }
);


/* Fermer en cliquant sur l'arrière-plan */

taskModalOverlay.addEventListener(
    "click",
    event => {

        if (event.target === taskModalOverlay) {
            closeModal(taskModalOverlay);
        }

    }
);


/* =========================================================
   AJOUT D'UNE TÂCHE
   ========================================================= */

taskForm.addEventListener(
    "submit",
    event => {

        event.preventDefault();


        const name =
            taskNameInput.value.trim();

        const urgency =
            taskUrgencyInput.value;


        if (!name) return;


        const newTask = {

            id:
                crypto.randomUUID
                ? crypto.randomUUID()
                : Date.now().toString(),

            name,

            urgency,

            status: "todo",

            archivedAt: null,

            description: "",

            tags: [],

            subtasks: [],

            createdAt:
                Date.now()

        };


        tasks.push(newTask);


        saveStorage(
            STORAGE_KEYS.tasks,
            tasks
        );


        renderTasks();


        taskForm.reset();

        taskUrgencyInput.value = "medium";

        closeModal(taskModalOverlay);

    }
);


/* =========================================================
   RENDU KANBAN
   ========================================================= */

const todoList =
    document.getElementById("todoList");

const progressList =
    document.getElementById("progressList");

const doneList =
    document.getElementById("doneList");

const todoCount =
    document.getElementById("todoCount");

const progressCount =
    document.getElementById("progressCount");

const doneCount =
    document.getElementById("doneCount");

const archivedCount =
    document.getElementById("archivedCount");

const archivedTasksModalOverlay =
    document.getElementById("archivedTasksModalOverlay");

const openArchivedTasksButton =
    document.getElementById("openArchivedTasks");

const closeArchivedTasksButton =
    document.getElementById("closeArchivedTasksModal");

const archivedTaskList =
    document.getElementById("archivedTaskList");

const archivedSearchInput =
    document.getElementById("archivedSearch");

const archivedUrgencyFilter =
    document.getElementById("archivedUrgencyFilter");

const archivedSort =
    document.getElementById("archivedSort");

const selectedDoneCount =
    document.getElementById("selectedDoneCount");

const archiveSelectedTasksButton =
    document.getElementById("archiveSelectedTasks");

const selectedDoneTaskIds =
    new Set();


function renderTasks() {

    todoList.innerHTML = "";

    progressList.innerHTML = "";

    doneList.innerHTML = "";

    tasks.forEach(task => {
        if (task.status !== "done") {
            selectedDoneTaskIds.delete(task.id);
        }
    });


    /* Ordre :
       urgent en premier,
       puis moyenne,
       puis faible
    */

    const urgencyOrder = {
        high: 0,
        medium: 1,
        low: 2
    };


    const sortedTasks =
        [...tasks].sort(
            (a, b) => {

                const urgencyDifference =
                    urgencyOrder[a.urgency] -
                    urgencyOrder[b.urgency];

                if (urgencyDifference !== 0) {
                    return urgencyDifference;
                }

                return a.createdAt - b.createdAt;

            }
        );


    sortedTasks.forEach(task => {

        const card =
            createTaskCard(task);


        if (task.status === "todo") {

            todoList.appendChild(card);

        } else if (task.status === "progress") {

            progressList.appendChild(card);

        } else if (task.status === "done") {

            doneList.appendChild(card);

        }

    });


    todoCount.textContent =
        tasks.filter(
            task => task.status === "todo"
        ).length;

    progressCount.textContent =
        tasks.filter(
            task => task.status === "progress"
        ).length;

    doneCount.textContent =
        tasks.filter(
            task => task.status === "done"
        ).length;

    archivedCount.textContent =
        tasks.filter(
            task => task.status === "archived"
        ).length;

    updateDoneSelectionControls();

    renderArchivedTasks();

}


function renderArchivedTasks() {

    if (!archivedTaskList) return;

    archivedTaskList.innerHTML = "";

    const searchTerm =
        archivedSearchInput.value.trim().toLowerCase();

    const urgencyFilter =
        archivedUrgencyFilter.value;

    const sortMode =
        archivedSort.value;

    const archivedTasks =
        tasks.filter(
            task => {
                const matchesSearch =
                    task.status === "archived" &&
                    task.name.toLowerCase().includes(searchTerm);

                const matchesUrgency =
                    urgencyFilter === "all" ||
                    task.urgency === urgencyFilter;

                return matchesSearch && matchesUrgency;
            }
        ).sort(
            (a, b) => {
                if (sortMode === "name") {
                    return a.name.localeCompare(b.name, "fr");
                }

                const dateA = a.archivedAt || a.createdAt;
                const dateB = b.archivedAt || b.createdAt;

                return sortMode === "oldest"
                    ? dateA - dateB
                    : dateB - dateA;
            }
        );

    if (archivedTasks.length === 0) {
        archivedTaskList.innerHTML = `
            <p class="archived-empty-state">
                ${searchTerm || urgencyFilter !== "all"
                    ? "Aucune tâche ne correspond à ces filtres."
                    : "Aucune tâche archivée pour le moment."}
            </p>
        `;
        return;
    }

    archivedTasks.forEach(task => {
        archivedTaskList.appendChild(
            createTaskCard(task)
        );
    });

}


function formatTaskDate(timestamp) {

    return new Intl.DateTimeFormat(
        "fr-FR",
        {
            day: "numeric",
            month: "short",
            year: "numeric"
        }
    ).format(timestamp);

}


function archiveTask(task) {

    task.status = "archived";
    task.archivedAt = Date.now();
    selectedDoneTaskIds.delete(task.id);

    saveStorage(
        STORAGE_KEYS.tasks,
        tasks
    );

    renderTasks();

}


function updateDoneSelectionControls() {

    const selectedCount =
        selectedDoneTaskIds.size;

    selectedDoneCount.textContent =
        `${selectedCount} sélectionnée${selectedCount > 1 ? "s" : ""}`;

    archiveSelectedTasksButton.disabled =
        selectedCount === 0;

}


function createTaskCard(task) {

    const card =
        document.createElement("div");


    card.className = "task-card";

    card.draggable = true;

    card.dataset.id = task.id;


    const urgencyNames = {

        low: "Faible",
        medium: "Moyenne",
        high: "Urgente"

    };


    const selectionAction = task.status === "done"
        ? `
            <label class="task-select" title="Sélectionner la tâche">
                <input
                    type="checkbox"
                    class="select-done-task"
                    ${selectedDoneTaskIds.has(task.id) ? "checked" : ""}
                    aria-label="Sélectionner ${escapeHTML(task.name)}"
                >
                <span></span>
            </label>
        `
        : "";

    const archiveAction = task.status === "done"
        ? `
            <button
                class="archive-task"
                aria-label="Archiver la tâche"
                title="Archiver la tâche"
            >
                ↗
            </button>
        `
        : "";

    const restoreAction = task.status === "archived"
        ? `
            <div class="restore-actions" aria-label="Restaurer la tâche">
                <button class="restore-task" data-restore-status="done" type="button" title="Restaurer dans Fait">Fait</button>
                <button class="restore-task" data-restore-status="todo" type="button" title="Restaurer dans À faire">À faire</button>
            </div>
        `
        : "";

    const taskDescription = task.description
        ? `<div class="task-description">${escapeHTML(task.description)}</div>`
        : "";

    const taskTags = Array.isArray(task.tags) && task.tags.length > 0
        ? `<div class="task-tags">${task.tags.map(tag => `<span>${escapeHTML(tag)}</span>`).join("")}</div>`
        : "";

    const subtaskSummary = Array.isArray(task.subtasks) && task.subtasks.length > 0
        ? `<span class="subtask-summary">${task.subtasks.length} sous-tâche${task.subtasks.length > 1 ? "s" : ""}</span>`
        : "";

    card.innerHTML = `

        <div class="task-title">
            ${selectionAction}
            ${escapeHTML(task.name)}
        </div>

        ${taskDescription}
        ${taskTags}

        ${task.status === "archived"
            ? `<div class="task-archived-date">Archivée le ${formatTaskDate(task.archivedAt || task.createdAt)}</div>`
            : ""}

        <div class="task-bottom">

            <span
                class="urgency urgency-${task.urgency}"
            >
                ${urgencyNames[task.urgency]}
            </span>

            ${subtaskSummary}

            <div class="task-actions">
                ${archiveAction}
                ${restoreAction}

                <button
                    class="delete-task"
                    aria-label="Supprimer la tâche"
                    title="Supprimer la tâche"
                >
                    ×
                </button>
            </div>

        </div>

    `;


    card.addEventListener(
        "click",
        event => {

            if (event.target.closest("button, input, label")) {
                return;
            }

            openTaskDetails(task);

        }
    );


    const selectDoneTask =
        card.querySelector(".select-done-task");


    if (selectDoneTask) {
        selectDoneTask.addEventListener(
            "click",
            event => event.stopPropagation()
        );

        selectDoneTask.addEventListener(
            "change",
            () => {
                if (selectDoneTask.checked) {
                    selectedDoneTaskIds.add(task.id);
                } else {
                    selectedDoneTaskIds.delete(task.id);
                }

                updateDoneSelectionControls();
            }
        );
    }


    /* Drag */

    card.addEventListener(
        "dragstart",
        event => {

            card.classList.add("dragging");

            event.dataTransfer.setData(
                "text/plain",
                task.id
            );

        }
    );


    const archiveButton =
        card.querySelector(".archive-task");


    if (archiveButton) {
        archiveButton.addEventListener(
            "click",
            event => {

                event.stopPropagation();

                archiveTask(task);

            }
        );
    }


    const restoreActions =
        card.querySelector(".restore-actions");


    if (restoreActions) {
        restoreActions.querySelectorAll("[data-restore-status]").forEach(
            restoreButton => restoreButton.addEventListener(
                "click",
                event => {

                    event.stopPropagation();

                    task.status = restoreButton.dataset.restoreStatus;
                    task.archivedAt = null;

                    saveStorage(
                        STORAGE_KEYS.tasks,
                        tasks
                    );

                    renderTasks();

                }
            )
        );
    }


    card.addEventListener(
        "dragend",
        () => {

            card.classList.remove(
                "dragging"
            );

        }
    );


    /* Suppression */

    const deleteButton =
        card.querySelector(".delete-task");


    deleteButton.addEventListener(
        "click",
        event => {

            event.stopPropagation();

            requestTaskDeletion(task);

        }
    );


    return card;

}


/* =========================================================
   DRAG & DROP KANBAN
   ========================================================= */

const kanbanColumns =
    document.querySelectorAll(".kanban-column");


kanbanColumns.forEach(column => {

    column.addEventListener(
        "dragover",
        event => {

            event.preventDefault();

            column.classList.add("drag-over");

        }
    );


    column.addEventListener(
        "dragleave",
        () => {

            column.classList.remove(
                "drag-over"
            );

        }
    );


    column.addEventListener(
        "drop",
        event => {

            event.preventDefault();

            column.classList.remove(
                "drag-over"
            );


            const taskId =
                event.dataTransfer.getData(
                    "text/plain"
                );


            const newStatus =
                column.dataset.status;


            const task =
                tasks.find(
                    currentTask =>
                        currentTask.id === taskId
                );


            if (!task) return;


            task.status = newStatus;


            saveStorage(
                STORAGE_KEYS.tasks,
                tasks
            );


            renderTasks();

        }
    );

});


archiveSelectedTasksButton.addEventListener(
    "click",
    () => {

        selectedDoneTaskIds.forEach(taskId => {
            const task = tasks.find(
                currentTask => currentTask.id === taskId
            );

            if (task && task.status === "done") {
                task.status = "archived";
                task.archivedAt = Date.now();
            }
        });

        selectedDoneTaskIds.clear();

        saveStorage(
            STORAGE_KEYS.tasks,
            tasks
        );

        renderTasks();

    }
);


openArchivedTasksButton.addEventListener(
    "click",
    () => {
        renderArchivedTasks();
        openModal(archivedTasksModalOverlay);
    }
);


archivedSearchInput.addEventListener(
    "input",
    renderArchivedTasks
);


archivedUrgencyFilter.addEventListener(
    "change",
    renderArchivedTasks
);


archivedSort.addEventListener(
    "change",
    renderArchivedTasks
);


closeArchivedTasksButton.addEventListener(
    "click",
    () => {
        closeModal(archivedTasksModalOverlay);
    }
);


archivedTasksModalOverlay.addEventListener(
    "click",
    event => {

        if (event.target === archivedTasksModalOverlay) {
            closeModal(archivedTasksModalOverlay);
        }

    }
);


/* =========================================================
   MODAL HABITUDES
   ========================================================= */

const habitModalOverlay =
    document.getElementById(
        "habitModalOverlay"
    );

const openHabitModalButton =
    document.getElementById(
        "openHabitModal"
    );

const emptyHabitButton =
    document.getElementById(
        "emptyHabitButton"
    );

const closeHabitModalButton =
    document.getElementById(
        "closeHabitModal"
    );

const cancelHabitModalButton =
    document.getElementById(
        "cancelHabitModal"
    );

const habitForm =
    document.getElementById(
        "habitForm"
    );

const habitNameInput =
    document.getElementById(
        "habitName"
    );


function openHabitModal() {

    openModal(habitModalOverlay);

    setTimeout(() => {
        habitNameInput.focus();
    }, 100);

}


openHabitModalButton.addEventListener(
    "click",
    openHabitModal
);


emptyHabitButton.addEventListener(
    "click",
    openHabitModal
);


closeHabitModalButton.addEventListener(
    "click",
    () => {
        closeModal(habitModalOverlay);
    }
);


cancelHabitModalButton.addEventListener(
    "click",
    () => {
        closeModal(habitModalOverlay);
    }
);


habitModalOverlay.addEventListener(
    "click",
    event => {

        if (event.target === habitModalOverlay) {
            closeModal(habitModalOverlay);
        }

    }
);


/* =========================================================
   AJOUT D'UNE HABITUDE
   ========================================================= */

habitForm.addEventListener(
    "submit",
    event => {

        event.preventDefault();


        const name =
            habitNameInput.value.trim();


        if (!name) return;


        const newHabit = {

            id:
                crypto.randomUUID
                ? crypto.randomUUID()
                : Date.now().toString(),

            name

        };


        habits.push(newHabit);


        /* Initialisation des complétions */

        if (!habitCompletions[newHabit.id]) {

            habitCompletions[newHabit.id] = {};

        }


        saveStorage(
            STORAGE_KEYS.habits,
            habits
        );


        saveStorage(
            STORAGE_KEYS.completions,
            habitCompletions
        );


        /*
         * On rerend le tableau.
         * Le système récupère automatiquement
         * les anciens pourcentages afin de
         * pouvoir animer ceux qui changent.
         */

        renderHabits(true);


        habitForm.reset();

        closeModal(habitModalOverlay);

    }
);


/* =========================================================
   DATES — OUTILS
   ========================================================= */

function startOfWeek(date) {

    const result =
        new Date(date);

    result.setHours(
        0,
        0,
        0,
        0
    );


    const day =
        result.getDay();


    const difference =
        day === 0
            ? -6
            : 1 - day;


    result.setDate(
        result.getDate() + difference
    );


    return result;

}


function formatDateKey(date) {

    const year =
        date.getFullYear();

    const month =
        String(
            date.getMonth() + 1
        ).padStart(2, "0");

    const day =
        String(
            date.getDate()
        ).padStart(2, "0");


    return `${year}-${month}-${day}`;

}


function formatShortDate(date) {

    return `${String(
        date.getDate()
    ).padStart(2, "0")}/${
        String(
            date.getMonth() + 1
        ).padStart(2, "0")
    }`;

}


function capitalize(text) {

    return text.charAt(0).toUpperCase()
        + text.slice(1);

}


/* =========================================================
   CONSTRUIRE LES 7 JOURS
   ========================================================= */

function getCurrentWeekDates() {

    const monday =
        startOfWeek(
            new Date()
        );


    const dates = [];


    for (let i = 0; i < 7; i++) {

        const date =
            new Date(monday);


        date.setDate(
            monday.getDate() + i
        );


        dates.push(date);

    }


    return dates;

}


/* =========================================================
   POURCENTAGE JOURNALIER
   ========================================================= */

function calculateDayPercentage(date) {

    if (!habits.length) {
        return 0;
    }


    let completed = 0;


    habits.forEach(habit => {

        const completionData =
            habitCompletions[habit.id];


        if (
            completionData &&
            completionData[date]
        ) {

            completed++;

        }

    });


    return Math.round(
        (completed / habits.length) * 100
    );

}


/* =========================================================
   ANIMATION MACHINE À SOUS
   ========================================================= */

/* =========================================================
   ANIMATION ROULETTE DES POURCENTAGES
   ========================================================= */

function animatePercentage(
    element,
    oldValue,
    newValue
) {

    if (!element) return;


    /*
     * Créer la structure intérieure si elle
     * n'existe pas encore.
     */

    let windowElement =
        element.querySelector(
            ".percentage-window"
        );


    if (!windowElement) {

        element.innerHTML = "";

        windowElement =
            document.createElement("span");

        windowElement.className =
            "percentage-window";


        const current =
            document.createElement("span");

        current.className =
            "percentage-value";

        current.textContent =
            `${oldValue}%`;


        windowElement.appendChild(
            current
        );

        element.appendChild(
            windowElement
        );

    }


    const current =
        windowElement.querySelector(
            ".percentage-value"
        );


    if (!current) return;


    /*
     * Aucun changement = aucune animation.
     */

    if (oldValue === newValue) {

        current.textContent =
            `${newValue}%`;

        element.dataset.value =
            newValue;

        return;

    }


    /*
     * Nouveau chiffre qui arrive par le bas.
     */

    const next =
        document.createElement("span");

    next.className =
        "percentage-value";

    next.textContent =
        `${newValue}%`;

    next.style.transition =
        "none";

    next.style.transform =
        "translateY(100%)";


    windowElement.appendChild(
        next
    );


    /*
     * Force le navigateur à appliquer
     * la position initiale.
     */

    void next.offsetWidth;


    /*
     * Les deux chiffres roulent :
     *
     * ancien → vers le haut
     * nouveau → depuis le bas
     */

    current.style.transition =
        "transform 0.42s cubic-bezier(.22,.8,.2,1)";

    next.style.transition =
        "transform 0.42s cubic-bezier(.22,.8,.2,1)";


    requestAnimationFrame(() => {

        current.style.transform =
            "translateY(-100%)";

        next.style.transform =
            "translateY(0)";

    });


    /*
     * Nettoyage après l'animation.
     */

    setTimeout(() => {

        current.remove();

        element.dataset.value =
            newValue;

    }, 440);

}


/* =========================================================
   RENDU HABITUDES
   ========================================================= */

const habitTableBody =
    document.getElementById(
        "habitTableBody"
    );

const emptyHabitsMessage =
    document.getElementById(
        "emptyHabitsMessage"
    );

const weekRange =
    document.getElementById(
        "weekRange"
    );


function renderHabits(
    animatePercentages = false
) {

    /*
     * Sauvegarder les anciennes valeurs
     * AVANT de vider le tableau.
     */

    const oldPercentages = {};


    document
        .querySelectorAll(".habit-percentage")
        .forEach(element => {

            const dayIndex =
                element.dataset.dayIndex;


            oldPercentages[dayIndex] =
                parseInt(
                    element.dataset.value || "0",
                    10
                );

        });


    /* Recréer le contenu */

    habitTableBody.innerHTML = "";


    const dates =
        getCurrentWeekDates();


    /* Date de la semaine */

    const firstDay =
        dates[0];

    const lastDay =
        dates[6];


    weekRange.textContent =
        `${formatShortDate(firstDay)} — ${formatShortDate(lastDay)}`;


    /* Dates dans les colonnes */

    dates.forEach(
        (date, index) => {

            const element =
                document.getElementById(
                    `date-${index}`
                );


            if (element) {

                element.textContent =
                    formatShortDate(date);

            }

        }
    );


    /* Message si aucune habitude */

    if (habits.length === 0) {

        emptyHabitsMessage.classList.add(
            "visible"
        );

    } else {

        emptyHabitsMessage.classList.remove(
            "visible"
        );

    }


    /* Créer une ligne par habitude */

    habits.forEach(habit => {

        const row =
            document.createElement("tr");


        /* Nom */

        const nameCell =
            document.createElement("td");


        nameCell.innerHTML = `

            <div class="habit-name-cell">

                <span class="habit-name-text">
                    ${escapeHTML(habit.name)}
                </span>

                <button
                    class="delete-habit"
                    aria-label="Supprimer l'habitude"
                >
                    ×
                </button>

            </div>

        `;


        row.appendChild(nameCell);


        /* 7 jours */

        dates.forEach(date => {

            const cell =
                document.createElement("td");


            const dateKey =
                formatDateKey(date);


            const isChecked =
                Boolean(
                    habitCompletions[habit.id] &&
                    habitCompletions[habit.id][dateKey]
                );


            const checkbox =
                document.createElement("input");


            checkbox.type = "checkbox";

            checkbox.className =
                "habit-check";

            checkbox.checked =
                isChecked;


            checkbox.dataset.habitId =
                habit.id;

            checkbox.dataset.date =
                dateKey;


            checkbox.addEventListener(
                "change",
                () => {

                    toggleHabitCompletion(
                        habit.id,
                        dateKey,
                        checkbox.checked
                    );

                }
            );


            cell.appendChild(
                checkbox
            );


            row.appendChild(cell);

        });


        /* Cellule vide finale */

        const finalCell =
            document.createElement("td");


        finalCell.className =
            "percentage-total";


        finalCell.textContent =
            "—";


        row.appendChild(
            finalCell
        );


        /* Suppression */

        const deleteHabitButton =
            nameCell.querySelector(
                ".delete-habit"
            );


        deleteHabitButton.addEventListener(
            "click",
            () => {

                deleteHabit(habit.id);

            }
        );


        habitTableBody.appendChild(
            row
        );

    });


    /* Mettre à jour les pourcentages */

    dates.forEach(
        (date, index) => {

            const percentage =
                calculateDayPercentage(
                    formatDateKey(date)
                );


            const element =
                document.querySelector(
                    `.habit-percentage[data-day-index="${index}"]`
                );


            if (!element) return;


            const oldValue =
                oldPercentages[index] ??
                percentage;


            if (
                animatePercentages &&
                oldValue !== percentage
            ) {

                /*
                 * Pour que l'utilisateur ait le temps
                 * de voir le changement, on démarre
                 * avec l'ancien nombre.
                 */

                element.textContent =
                    `${oldValue}%`;

                element.dataset.value =
                    oldValue;


                animatePercentage(
                    element,
                    oldValue,
                    percentage
                );

            } else {

                element.innerHTML = `
                    <span class="percentage-window">
                        <span class="percentage-value">
                            ${percentage}%
                        </span>
                    </span>
                `;

                element.dataset.value = percentage;
            }

        }
    );

}


/* =========================================================
   COCHER / DÉCOCHER UNE HABITUDE
   ========================================================= */

function toggleHabitCompletion(
    habitId,
    date,
    completed
) {

    if (!habitCompletions[habitId]) {

        habitCompletions[habitId] = {};

    }


    if (completed) {

        habitCompletions[habitId][date] =
            true;

    } else {

        delete habitCompletions[habitId][date];

    }


    saveStorage(
        STORAGE_KEYS.completions,
        habitCompletions
    );


    /*
     * IMPORTANT :
     * Le tableau est reconstruit avec animation.
     */

    renderHabits(true);


    /*
     * Si le graphique est déjà ouvert,
     * on le met aussi à jour.
     */

    renderGraph();

}


/* =========================================================
   SUPPRESSION D'UNE HABITUDE
   ========================================================= */

function deleteHabit(habitId) {

    habits =
        habits.filter(
            habit =>
                habit.id !== habitId
        );


    delete habitCompletions[habitId];


    saveStorage(
        STORAGE_KEYS.habits,
        habits
    );


    saveStorage(
        STORAGE_KEYS.completions,
        habitCompletions
    );


    renderHabits(true);

    renderGraph();

}


/* =========================================================
   GRAPH — ÉTAT
   ========================================================= */

let graphDate = new Date();


/* =========================================================
   MOIS
   ========================================================= */

const monthNames = [

    "Janvier",
    "Février",
    "Mars",
    "Avril",
    "Mai",
    "Juin",
    "Juillet",
    "Août",
    "Septembre",
    "Octobre",
    "Novembre",
    "Décembre"

];


function getDaysInMonth(
    year,
    month
) {

    return new Date(
        year,
        month + 1,
        0
    ).getDate();

}


/* =========================================================
   CALCUL POUR LE GRAPHIQUE
   ========================================================= */

function getMonthData(
    year,
    month
) {

    const days =
        getDaysInMonth(
            year,
            month
        );


    const data = [];


    for (
        let day = 1;
        day <= days;
        day++
    ) {

        const date =
            new Date(
                year,
                month,
                day
            );


        const dateKey =
            formatDateKey(date);


        data.push({

            day,

            dateKey,

            percentage:
                calculateDayPercentage(
                    dateKey
                )

        });

    }


    return data;

}


/* =========================================================
   RENDU GRAPHIQUE
   ========================================================= */

const habitGraph =
    document.getElementById(
        "habitGraph"
    );

const graphMonthTitle =
    document.getElementById(
        "graphMonthTitle"
    );

const monthlyAverage =
    document.getElementById(
        "monthlyAverage"
    );

const graphDays =
    document.getElementById(
        "graphDays"
    );

const graphTooltip =
    document.getElementById(
        "graphTooltip"
    );


function renderGraph() {

    const year =
        graphDate.getFullYear();

    const month =
        graphDate.getMonth();


    const data =
        getMonthData(
            year,
            month
        );


    graphMonthTitle.textContent =
        `${monthNames[month]} ${year}`;


    /* Moyenne */

    const sum =
        data.reduce(
            (total, item) =>
                total + item.percentage,
            0
        );


    const average =
        data.length
            ? Math.round(
                sum / data.length
            )
            : 0;


    monthlyAverage.textContent =
        `${average}%`;


    /* Nettoyer */

    habitGraph.innerHTML = "";

    graphDays.innerHTML = "";


    /* Dimensions */
        const width = 1000;
        const height = 400;

        const paddingLeft = 35;
        const paddingRight = 25;
        const paddingTop = 20;
        const paddingBottom = 20;

        const graphWidth =
            width -
            paddingLeft -
            paddingRight;

        const graphHeight =
            height -
            paddingTop -
            paddingBottom;


    /* Grille 0 / 25 / 50 / 75 / 100 */

    [0, 25, 50, 75, 100]
        .forEach(value => {

            const y =
                paddingTop +
                (
                    100 - value
                ) /
                100 *
                graphHeight;


            const line =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "line"
                );


            line.setAttribute(
                "x1",
                paddingLeft
            );

            line.setAttribute(
                "x2",
                width - paddingRight
            );

            line.setAttribute(
                "y1",
                y
            );

            line.setAttribute(
                "y2",
                y
            );

            line.setAttribute(
                "class",
                "graph-grid-line"
            );


            habitGraph.appendChild(
                line
            );

        });


    /* Coordonnées */

    const points =
        data.map(
            (item, index) => {

                const x =
                    paddingLeft +
                    (
                        index /
                        Math.max(
                            data.length - 1,
                            1
                        )
                    ) *
                    graphWidth;


                const y =
                    paddingTop +
                    (
                        100 -
                        item.percentage
                    ) /
                    100 *
                    graphHeight;


                return {
                    x,
                    y,
                    ...item
                };

            }
        );


    /* Ligne */

    let linePath = "";

    points.forEach(
        (point, index) => {

            linePath +=
                index === 0
                    ? `M ${point.x} ${point.y}`
                    : ` L ${point.x} ${point.y}`;

        }
    );


    const path =
        document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path"
        );


    path.setAttribute(
        "d",
        linePath
    );


    path.setAttribute(
        "class",
        "graph-line"
    );


    habitGraph.appendChild(
        path
    );


    /* Points */

    points.forEach(
        point => {

            const circle =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "circle"
                );


            circle.setAttribute(
                "cx",
                point.x
            );

            circle.setAttribute(
                "cy",
                point.y
            );

            circle.setAttribute(
                "r",
                5
            );

            circle.setAttribute(
                "class",
                "graph-point"
            );


            circle.addEventListener(
                "mouseenter",
                event => {

                    showGraphTooltip(
                        event,
                        point
                    );

                }
            );


            circle.addEventListener(
                "mouseleave",
                hideGraphTooltip
            );


            habitGraph.appendChild(
                circle
            );

        }
    );


    /* Jours */
    /* Même nombre de colonnes que de jours */

    graphDays.style.gridTemplateColumns =
        `repeat(${data.length}, minmax(0, 1fr))`;


    data.forEach(
        item => {

            const span =
                document.createElement(
                    "span"
                );


            span.textContent =
                item.day;


            graphDays.appendChild(
                span
            );

        }
    );

}


/* =========================================================
   TOOLTIP GRAPHIQUE
   ========================================================= */

function showGraphTooltip(
    event,
    point
) {

    const rect =
        habitGraph.getBoundingClientRect();


    const xRatio =
        point.x / 1000;


    const yRatio =
        point.y / 400;


    graphTooltip.style.display =
        "block";


    graphTooltip.style.left =
        `${xRatio * 100}%`;


    graphTooltip.style.top =
        `${yRatio * 100}%`;


    graphTooltip.textContent =
        `${point.day} — ${point.percentage}%`;

}


function hideGraphTooltip() {

    graphTooltip.style.display =
        "none";

}


/* =========================================================
   NAVIGATION ENTRE TABLEAU ET GRAPHIQUE
   ========================================================= */

const goToGraphButton =
    document.getElementById("goToGraph");

const goToTableButton =
    document.getElementById("goToTable");

const habitTableSlide =
    document.getElementById("habitTableSlide");

const habitGraphSlide =
    document.getElementById("habitGraphSlide");


/* ---------------------------------------------------------
   TABLEAU → GRAPHIQUE
   --------------------------------------------------------- */

if (goToGraphButton) {

    goToGraphButton.addEventListener(
        "click",
        () => {

            habitTableSlide.classList.remove("active");

            habitGraphSlide.classList.add("active");

            renderGraph();

        }
    );

}


/* ---------------------------------------------------------
   GRAPHIQUE → TABLEAU
   --------------------------------------------------------- */

if (goToTableButton) {

    goToTableButton.addEventListener(
        "click",
        () => {

            habitGraphSlide.classList.remove("active");

            habitTableSlide.classList.add("active");

        }
    );

}

/* =========================================================
   MOIS PRÉCÉDENT / SUIVANT
   ========================================================= */

const previousMonthButton =
    document.getElementById(
        "previousMonth"
    );

const nextMonthButton =
    document.getElementById(
        "nextMonth"
    );


previousMonthButton.addEventListener(
    "click",
    () => {

        graphDate =
            new Date(
                graphDate.getFullYear(),
                graphDate.getMonth() - 1,
                1
            );


        renderGraph();

    }
);


nextMonthButton.addEventListener(
    "click",
    () => {

        graphDate =
            new Date(
                graphDate.getFullYear(),
                graphDate.getMonth() + 1,
                1
            );


        renderGraph();

    }
);


/* =========================================================
   ESCAPE HTML
   ========================================================= */

function escapeHTML(text) {

    const div =
        document.createElement("div");

    div.textContent =
        text;

    return div.innerHTML;

}


/* =========================================================
   FERMER LES MODALES AVEC ESC
   ========================================================= */

document.addEventListener(
    "keydown",
    event => {

        if (event.key !== "Escape") {
            return;
        }


        closeModal(
            taskModalOverlay
        );

        closeModal(
            habitModalOverlay
        );

        closeTaskDetails();

        closeDeleteConfirmation();

    }
);

/* =========================================================
   WORK UP — FOCUS
   ========================================================= */


/* =========================================================
   1. STOCKAGE
   ========================================================= */

/*
 * Toutes les sessions terminées sont sauvegardées
 * dans le navigateur.
 */

const FOCUS_STORAGE_KEY = "workUpFocusSessions";


/*
 * Récupération des sessions existantes.
 */

let focusSessions = loadStorage(
    FOCUS_STORAGE_KEY,
    []
);


/* =========================================================
   2. ÉTAT DU TIMER
   ========================================================= */

let focusTimerInterval = null;

let focusElapsed = 0;

let focusStartedAt = null;

let focusPaused = false;

let focusSessionName = "";


/* =========================================================
   3. RÉCUPÉRATION DES ÉLÉMENTS HTML
   ========================================================= */

/* ---------- Timer ---------- */

const focusRing =
    document.getElementById("focusRing");

const focusTime =
    document.getElementById("focusTime");

const focusMinute =
    document.getElementById("focusMinute");

const focusSessionNameElement =
    document.getElementById("focusSessionName");

const focusStatus =
    document.getElementById("focusStatus");


/* ---------- Boutons ---------- */

const startFocusButton =
    document.getElementById("startFocusButton");

const pauseFocusButton =
    document.getElementById("pauseFocusButton");

const finishFocusButton =
    document.getElementById("finishFocusButton");


/* ---------- Historique ---------- */

const focusHistoryList =
    document.getElementById("focusHistoryList");

const focusEmptyHistory =
    document.getElementById("focusEmptyHistory");


/* ---------- Statistiques ---------- */

const focusChart =
    document.getElementById("focusChart");

const focusTotalTime =
    document.getElementById("focusTotalTime");


/* ---------- Popup ---------- */

const focusModalOverlay =
    document.getElementById("focusModalOverlay");

const closeFocusModalButton =
    document.getElementById("closeFocusModal");

const cancelFocusModalButton =
    document.getElementById("cancelFocusModal");

const focusSessionForm =
    document.getElementById("focusSessionForm");

const focusSessionInput =
    document.getElementById("focusSessionInput");


/* =========================================================
   4. FORMATAGE DU TEMPS
   ========================================================= */

/*
 * Transforme un nombre de secondes en :
 *
 * 00:00
 * 04:32
 * 01:24:18
 */

function formatFocusTime(seconds) {

    seconds = Math.max(
        0,
        Math.floor(seconds)
    );


    const hours =
        Math.floor(seconds / 3600);


    const minutes =
        Math.floor(
            (seconds % 3600) / 60
        );


    const remainingSeconds =
        seconds % 60;


    /*
     * Si la session dépasse une heure,
     * on affiche HH:MM:SS.
     */

    if (hours > 0) {

        return (
            String(hours).padStart(2, "0") +
            ":" +
            String(minutes).padStart(2, "0") +
            ":" +
            String(remainingSeconds).padStart(2, "0")
        );

    }


    /*
     * Sinon :
     * MM:SS
     */

    return (
        String(minutes).padStart(2, "0") +
        ":" +
        String(remainingSeconds).padStart(2, "0")
    );

}


/* =========================================================
   5. FORMATAGE COURT
   ========================================================= */

/*
 * Utilisé dans l'historique et les statistiques.
 *
 * 45 secondes → 0 min
 * 42 minutes  → 42 min
 * 1h 12       → 1h 12min
 */

function formatFocusDuration(seconds) {

    seconds = Math.max(
        0,
        Math.floor(seconds)
    );


    const hours =
        Math.floor(seconds / 3600);


    const minutes =
        Math.floor(
            (seconds % 3600) / 60
        );


    if (hours > 0) {

        if (minutes === 0) {

            return `${hours}h`;

        }


        return `${hours}h ${minutes}min`;

    }


    return `${minutes} min`;

}


/* =========================================================
   6. DATE AU FORMAT YYYY-MM-DD
   ========================================================= */

function getFocusDateKey(
    date = new Date()
) {

    return [
        date.getFullYear(),

        String(
            date.getMonth() + 1
        ).padStart(2, "0"),

        String(
            date.getDate()
        ).padStart(2, "0")

    ].join("-");

}


/* =========================================================
   7. DATE LISIBLE
   ========================================================= */

function formatFocusDate(dateString) {

    const parts =
        dateString.split("-");


    if (parts.length !== 3) {

        return dateString;

    }


    const year =
        Number(parts[0]);

    const month =
        Number(parts[1]) - 1;

    const day =
        Number(parts[2]);


    const date =
        new Date(
            year,
            month,
            day
        );


    return date.toLocaleDateString(
        "fr-FR",
        {
            weekday: "short",
            day: "numeric",
            month: "short"
        }
    );

}


/* =========================================================
   8. ÉCHAPPEMENT HTML
   ========================================================= */

/*
 * Empêche qu'un nom de session contenant
 * du HTML soit interprété comme du HTML.
 */

function escapeFocusHTML(value) {

    const div =
        document.createElement("div");


    div.textContent =
        String(value);


    return div.innerHTML;

}


/* =========================================================
   9. MISE À JOUR DE L'AFFICHAGE
   ========================================================= */

function updateFocusDisplay() {

    if (!focusTime) {

        return;

    }


    /*
     * Chronomètre principal.
     */

    focusTime.textContent =
        formatFocusTime(
            focusElapsed
        );


    /*
     * Nombre de minutes complètes.
     */

    const minutes =
        Math.floor(
            focusElapsed / 60
        );


    if (focusMinute) {

        focusMinute.textContent =
            `${minutes} min`;

    }


    /*
     * =====================================================
     * CERCLE
     * =====================================================
     *
     * Le cercle représente uniquement
     * la minute actuelle.
     *
     * 00 sec → 0°
     * 15 sec → 90°
     * 30 sec → 180°
     * 45 sec → 270°
     * 59 sec → presque 360°
     * 60 sec → retour à 0°
     */

    if (focusRing) {

        const secondsInMinute =
            focusElapsed % 60;


        const progress =
            (
                secondsInMinute / 60
            ) * 360;


        focusRing.style.setProperty(
            "--progress",
            `${progress}deg`
        );

    }

}


/* =========================================================
   10. OUVRIR LA POPUP
   ========================================================= */

function openFocusModal() {

    if (!focusModalOverlay) {

        return;

    }


    focusModalOverlay.classList.add(
        "active"
    );


    /*
     * On remet le champ vide
     * à chaque ouverture.
     */

    if (focusSessionInput) {

        focusSessionInput.value = "";

    }


    /*
     * Focus automatique dans le champ.
     */

    setTimeout(
        () => {

            if (focusSessionInput) {

                focusSessionInput.focus();

            }

        },
        150
    );

}


/* =========================================================
   11. FERMER LA POPUP
   ========================================================= */

function closeFocusModal() {

    if (!focusModalOverlay) {

        return;

    }


    focusModalOverlay.classList.remove(
        "active"
    );

}


/* =========================================================
   12. LANCER UNE SESSION
   ========================================================= */

function startFocusSession(
    sessionName
) {

    /*
     * Nettoyage du nom.
     */

    const cleanName =
        sessionName.trim();


    /*
     * Impossible de démarrer
     * sans nom.
     */

    if (!cleanName) {

        return;

    }


    /*
     * État initial.
     */

    focusSessionName =
        cleanName;

    focusElapsed =
        0;

    focusPaused =
        false;

    focusStartedAt =
        Date.now();


    /*
     * Affichage.
     */

    if (focusSessionNameElement) {

        focusSessionNameElement.textContent =
            focusSessionName;

    }


    if (focusStatus) {

        focusStatus.textContent =
            "SESSION EN COURS";

        focusStatus.classList.add(
            "running"
        );

        focusStatus.classList.remove(
            "paused"
        );

    }


    /*
     * Boutons.
     */

    if (startFocusButton) {

        startFocusButton.hidden =
            true;

    }


    if (pauseFocusButton) {

        pauseFocusButton.hidden =
            false;

        pauseFocusButton.textContent =
            "Pause";

    }


    if (finishFocusButton) {

        finishFocusButton.hidden =
            false;

    }


    /*
     * Affichage initial.
     */

    updateFocusDisplay();


    /*
     * Sécurité :
     * on supprime un ancien intervalle
     * avant d'en créer un nouveau.
     */

    clearInterval(
        focusTimerInterval
    );


    /*
     * Une seconde = +1 seconde.
     */

    focusTimerInterval =
        setInterval(
            tickFocusTimer,
            1000
        );

}


/* =========================================================
   13. TICK DU TIMER
   ========================================================= */

function tickFocusTimer() {

    /*
     * Si la session est en pause,
     * on ne fait rien.
     */

    if (
        focusPaused ||
        focusStartedAt === null
    ) {

        return;

    }


    /*
     * Une seconde supplémentaire.
     */

    focusElapsed++;


    /*
     * Mise à jour de l'interface.
     */

    updateFocusDisplay();

}


/* =========================================================
   14. PAUSE / REPRISE
   ========================================================= */

function toggleFocusPause() {

    /*
     * Pas de session active.
     */

    if (
        focusStartedAt === null
    ) {

        return;

    }


    /*
     * Inversion de l'état.
     */

    focusPaused =
        !focusPaused;


    if (focusPaused) {

        /*
         * ---------- PAUSE ----------
         */

        if (focusStatus) {

            focusStatus.textContent =
                "SESSION EN PAUSE";

            focusStatus.classList.remove(
                "running"
            );

            focusStatus.classList.add(
                "paused"
            );

        }


        if (pauseFocusButton) {

            pauseFocusButton.textContent =
                "Reprendre";

        }


    } else {

        /*
         * ---------- REPRISE ----------
         */

        if (focusStatus) {

            focusStatus.textContent =
                "SESSION EN COURS";

            focusStatus.classList.add(
                "running"
            );

            focusStatus.classList.remove(
                "paused"
            );

        }


        if (pauseFocusButton) {

            pauseFocusButton.textContent =
                "Pause";

        }

    }

}


/* =========================================================
   15. TERMINER LA SESSION
   ========================================================= */

function finishFocusSession() {

    /*
     * Rien à terminer.
     */

    if (
        focusStartedAt === null
    ) {

        return;

    }


    /*
     * Arrêt du timer.
     */

    clearInterval(
        focusTimerInterval
    );


    focusTimerInterval =
        null;


    /*
     * On ne sauvegarde pas
     * une session de 0 seconde.
     */

    if (
        focusElapsed <= 0
    ) {

        resetFocusTimer();

        return;

    }


    const now =
        new Date();


    /*
     * Création de la session.
     */

    const session = {

        id:
            (
                typeof crypto !== "undefined" &&
                crypto.randomUUID
            )
                ? crypto.randomUUID()
                : String(Date.now()),

        name:
            focusSessionName,

        duration:
            focusElapsed,

        date:
            getFocusDateKey(now),

        createdAt:
            now.toISOString()

    };


    /*
     * Ajout au début de l'historique.
     */

    focusSessions.unshift(
        session
    );


    /*
     * Maximum 100 sessions conservées.
     */

    focusSessions =
        focusSessions.slice(
            0,
            100
        );


    /*
     * Sauvegarde.
     */

    saveStorage(
        FOCUS_STORAGE_KEY,
        focusSessions
    );


    /*
     * Reset du timer.
     */

    resetFocusTimer();


    /*
     * Actualisation de l'interface.
     */

    renderFocusHistory();

    renderFocusStats();

}


/* =========================================================
   16. RESET DU TIMER
   ========================================================= */

function resetFocusTimer() {

    /*
     * Arrêt de l'intervalle.
     */

    clearInterval(
        focusTimerInterval
    );


    focusTimerInterval =
        null;


    /*
     * Réinitialisation de l'état.
     */

    focusElapsed =
        0;

    focusStartedAt =
        null;

    focusPaused =
        false;

    focusSessionName =
        "";


    /*
     * Texte.
     */

    if (focusSessionNameElement) {

        focusSessionNameElement.textContent =
            "Aucune session";

    }


    if (focusStatus) {

        focusStatus.textContent =
            "PRÊT À COMMENCER";

        focusStatus.classList.remove(
            "running",
            "paused"
        );

    }


    /*
     * Boutons.
     */

    if (startFocusButton) {

        startFocusButton.hidden =
            false;

    }


    if (pauseFocusButton) {

        pauseFocusButton.hidden =
            true;

        pauseFocusButton.textContent =
            "Pause";

    }


    if (finishFocusButton) {

        finishFocusButton.hidden =
            true;

    }


    /*
     * Retour du cercle à 0.
     */

    updateFocusDisplay();

}


/* =========================================================
   17. HISTORIQUE
   ========================================================= */

function renderFocusHistory() {

    if (
        !focusHistoryList ||
        !focusEmptyHistory
    ) {

        return;

    }


    /*
     * Nettoyage.
     */

    focusHistoryList.innerHTML =
        "";


    /*
     * Aucune session.
     */

    if (
        focusSessions.length === 0
    ) {

        focusEmptyHistory.style.display =
            "flex";

        return;

    }


    /*
     * Il y a des sessions.
     */

    focusEmptyHistory.style.display =
        "none";


    /*
     * On affiche les 8 dernières.
     */

    focusSessions
        .slice(0, 8)
        .forEach(
            session => {

                const item =
                    document.createElement(
                        "div"
                    );


                item.className =
                    "focus-history-item";


                item.innerHTML = `

                    <div class="focus-history-left">

                        <div class="focus-history-icon">
                            ◷
                        </div>

                        <div class="focus-history-info">

                            <div
                                class="focus-history-name"
                            >
                                ${escapeFocusHTML(session.name)}
                            </div>

                            <div
                                class="focus-history-date"
                            >
                                ${formatFocusDate(session.date)}
                            </div>

                        </div>

                    </div>


                    <div
                        class="focus-history-duration"
                    >
                        ${formatFocusDuration(session.duration)}
                    </div>

                `;


                focusHistoryList.appendChild(
                    item
                );

            }
        );

}


/* =========================================================
   18. STATISTIQUES
   ========================================================= */

function renderFocusStats() {

    if (
        !focusChart ||
        !focusTotalTime
    ) {

        return;

    }


    /*
     * =====================================================
     * 7 DERNIERS JOURS
     * =====================================================
     */

    const days = [];


    for (
        let i = 6;
        i >= 0;
        i--
    ) {

        const date =
            new Date();


        date.setHours(
            0,
            0,
            0,
            0
        );


        date.setDate(
            date.getDate() - i
        );


        days.push({

            key:
                getFocusDateKey(date),

            label:
                date
                    .toLocaleDateString(
                        "fr-FR",
                        {
                            weekday: "short"
                        }
                    )
                    .replace(
                        ".",
                        ""
                    )
                    .slice(0, 2)

        });

    }


    /*
     * Temps travaillé pour chaque jour.
     */

    const dailyTotals =
        days.map(
            day => {

                return focusSessions
                    .filter(
                        session =>
                            session.date ===
                            day.key
                    )
                    .reduce(
                        (
                            total,
                            session
                        ) => {

                            return (
                                total +
                                Number(
                                    session.duration
                                )
                            );

                        },
                        0
                    );

            }
        );


    /*
     * Plus grosse journée.
     */

    const maxDailyTime =
        Math.max(
            ...dailyTotals,
            1
        );


    /*
     * Nettoyage du graphique.
     */

    focusChart.innerHTML =
        "";


    /*
     * Création des 7 colonnes.
     */

    days.forEach(
        (day, index) => {

            const seconds =
                dailyTotals[index];


            /*
             * Hauteur de la barre
             * entre 0 et 100%.
             */

            const height =
                (
                    seconds /
                    maxDailyTime
                ) * 100;


            const column =
                document.createElement(
                    "div"
                );


            column.className =
                "focus-chart-day";


            column.innerHTML = `

                <span
                    class="focus-chart-value"
                >
                    ${
                        seconds > 0
                            ? formatFocusDuration(
                                seconds
                              )
                            : ""
                    }
                </span>


                <div
                    class="focus-chart-bar-wrapper"
                >

                    <div
                        class="focus-chart-bar"
                        style="
                            height:
                            ${Math.max(
                                height,
                                2
                            )}%;
                        "
                    ></div>

                </div>


                <span
                    class="focus-chart-label"
                >
                    ${escapeFocusHTML(
                        day.label
                    )}
                </span>

            `;


            focusChart.appendChild(
                column
            );

        }
    );


    /*
     * =====================================================
     * TEMPS TOTAL
     * =====================================================
     */

    const total =
        focusSessions.reduce(
            (
                sum,
                session
            ) => {

                return (
                    sum +
                    Number(
                        session.duration
                    )
                );

            },
            0
        );


    focusTotalTime.textContent =
        formatFocusDuration(
            total
        );

}


/* =========================================================
   19. FORMULAIRE DE LA POPUP
   ========================================================= */

if (focusSessionForm) {

    focusSessionForm.addEventListener(
        "submit",
        event => {

            event.preventDefault();


            const name =
                focusSessionInput
                    ? focusSessionInput.value.trim()
                    : "";


            /*
             * Champ vide.
             */

            if (!name) {

                if (focusSessionInput) {

                    focusSessionInput.focus();

                }

                return;

            }


            /*
             * Fermeture de la popup.
             */

            closeFocusModal();


            /*
             * Lancement de la session.
             */

            startFocusSession(
                name
            );

        }
    );

}


/* =========================================================
   20. BOUTON DÉBUTER
   ========================================================= */

if (startFocusButton) {

    startFocusButton.addEventListener(
        "click",
        openFocusModal
    );

}


/* =========================================================
   21. BOUTON PAUSE / REPRENDRE
   ========================================================= */

if (pauseFocusButton) {

    pauseFocusButton.addEventListener(
        "click",
        toggleFocusPause
    );

}


/* =========================================================
   22. BOUTON TERMINER
   ========================================================= */

if (finishFocusButton) {

    finishFocusButton.addEventListener(
        "click",
        finishFocusSession
    );

}


/* =========================================================
   23. FERMETURE DE LA POPUP
   ========================================================= */

if (closeFocusModalButton) {

    closeFocusModalButton.addEventListener(
        "click",
        closeFocusModal
    );

}


if (cancelFocusModalButton) {

    cancelFocusModalButton.addEventListener(
        "click",
        closeFocusModal
    );

}


/* =========================================================
   24. CLIQUER EN DEHORS DE LA POPUP
   ========================================================= */

if (focusModalOverlay) {

    focusModalOverlay.addEventListener(
        "click",
        event => {

            /*
             * On ferme uniquement si le clic
             * est directement sur l'overlay.
             */

            if (
                event.target ===
                focusModalOverlay
            ) {

                closeFocusModal();

            }

        }
    );

}


/* =========================================================
   25. TOUCHE ESCAPE
   ========================================================= */

document.addEventListener(
    "keydown",
    event => {

        if (
            event.key === "Escape" &&
            focusModalOverlay &&
            focusModalOverlay.classList.contains(
                "active"
            )
        ) {

            closeFocusModal();

        }

    }
);


/* =========================================================
   26. INITIALISATION
   ========================================================= */

renderFocusHistory();

renderFocusStats();

updateFocusDisplay();

/* =========================================================
   INITIALISATION
   ========================================================= */

renderTasks();

renderHabits(false);

renderGraph();

/* =========================================================
   WORK UP — POMODORO
   ========================================================= */

const pomodoroTimer =
    document.getElementById("pomodoroTimer");

const pomodoroPhase =
    document.getElementById("pomodoroPhase");

const pomodoroCycle =
    document.getElementById("pomodoroCycle");

const pomodoroStart =
    document.getElementById("pomodoroStart");

const pomodoroFinish =
    document.getElementById("pomodoroFinish");

const pomodoroWorkDuration =
    document.getElementById("pomodoroWorkDuration");

const pomodoroBreakDuration =
    document.getElementById("pomodoroBreakDuration");


let pomodoroInterval = null;

let pomodoroTimeLeft = 25 * 60;

let pomodoroIsRunning = false;

let pomodoroIsWork = true;

let pomodoroCurrentCycle = 1;


/* ---------------------------------------------------------
   RÉCUPÉRER LES DURÉES
   --------------------------------------------------------- */

function getPomodoroDurations() {

    let work =
        parseInt(
            pomodoroWorkDuration.value,
            10
        );

    let breakTime =
        parseInt(
            pomodoroBreakDuration.value,
            10
        );

    if (
        !Number.isFinite(work) ||
        work < 1
    ) {
        work = 25;
        pomodoroWorkDuration.value = 25;
    }

    if (
        !Number.isFinite(breakTime) ||
        breakTime < 1
    ) {
        breakTime = 5;
        pomodoroBreakDuration.value = 5;
    }

    work = Math.min(work, 180);
    breakTime = Math.min(breakTime, 60);

    pomodoroWorkDuration.value = work;
    pomodoroBreakDuration.value = breakTime;

    return {
        work,
        breakTime
    };
}


/* ---------------------------------------------------------
   AFFICHAGE DU TEMPS
   --------------------------------------------------------- */

function updatePomodoroDisplay() {

    const minutes =
        Math.floor(
            pomodoroTimeLeft / 60
        );

    const seconds =
        pomodoroTimeLeft % 60;

    pomodoroTimer.textContent =
        `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    pomodoroPhase.textContent =
        pomodoroIsWork
            ? "TRAVAIL"
            : "REPOS";

    pomodoroCycle.textContent =
        pomodoroCurrentCycle;
}


/* ---------------------------------------------------------
   PASSAGE À LA PHASE SUIVANTE
   --------------------------------------------------------- */

function switchPomodoroPhase() {

    const durations =
        getPomodoroDurations();


    /*
     * Travail terminé
     * → passage au repos
     */

    if (pomodoroIsWork) {

        pomodoroIsWork = false;

        pomodoroTimeLeft =
            durations.breakTime * 60;

    }


    /*
     * Repos terminé
     * → nouveau cycle de travail
     */

    else {

        pomodoroIsWork = true;

        pomodoroCurrentCycle++;

        pomodoroTimeLeft =
            durations.work * 60;

    }


    updatePomodoroDisplay();

}


/* ---------------------------------------------------------
   DÉMARRER
   --------------------------------------------------------- */

function startPomodoro() {

    if (pomodoroIsRunning) {
        return;
    }


    /*
     * Si le timer est à zéro,
     * on initialise la phase actuelle.
     */

    if (pomodoroTimeLeft <= 0) {

        const durations =
            getPomodoroDurations();

        pomodoroTimeLeft =
            pomodoroIsWork
                ? durations.work * 60
                : durations.breakTime * 60;

    }


    pomodoroIsRunning = true;

    pomodoroStart.textContent =
        "Pause";

    pomodoroFinish.hidden = false;


    pomodoroInterval =
        setInterval(() => {

            pomodoroTimeLeft--;

            updatePomodoroDisplay();


            /*
             * Phase terminée
             */

            if (pomodoroTimeLeft <= 0) {

                switchPomodoroPhase();

            }

        }, 1000);

}


/* ---------------------------------------------------------
   PAUSE / REPRISE
   --------------------------------------------------------- */

function togglePomodoro() {

    if (!pomodoroIsRunning) {

        startPomodoro();

        return;

    }


    clearInterval(
        pomodoroInterval
    );

    pomodoroInterval = null;

    pomodoroIsRunning = false;

    pomodoroStart.textContent =
        "Reprendre";

}


/* ---------------------------------------------------------
   FINIR LA SESSION
   --------------------------------------------------------- */

function finishPomodoro() {

    clearInterval(
        pomodoroInterval
    );

    pomodoroInterval = null;

    pomodoroIsRunning = false;

    pomodoroIsWork = true;

    pomodoroCurrentCycle = 1;

    pomodoroTimeLeft =
        parseInt(
            pomodoroWorkDuration.value,
            10
        ) * 60;

    pomodoroStart.textContent =
        "Démarrer";

    pomodoroFinish.hidden = true;

    updatePomodoroDisplay();

}


/* ---------------------------------------------------------
   CHANGEMENT DES DURÉES
   --------------------------------------------------------- */

function updatePomodoroDuration() {

    /*
     * On ne modifie pas un timer
     * actuellement en cours.
     */

    if (pomodoroIsRunning) {
        return;
    }

    const durations =
        getPomodoroDurations();

    pomodoroTimeLeft =
        pomodoroIsWork
            ? durations.work * 60
            : durations.breakTime * 60;

    updatePomodoroDisplay();

}


pomodoroStart.addEventListener(
    "click",
    togglePomodoro
);


pomodoroFinish.addEventListener(
    "click",
    finishPomodoro
);


pomodoroWorkDuration.addEventListener(
    "change",
    updatePomodoroDuration
);


pomodoroBreakDuration.addEventListener(
    "change",
    updatePomodoroDuration
);


/* ---------------------------------------------------------
   INITIALISATION
   --------------------------------------------------------- */

updatePomodoroDisplay();

/* =========================================================
   WORK UP — ROUE DE LA FORTUNE
   ========================================================= */

const WHEEL_STORAGE_KEY = "workUpWheelIssues";

const fortuneWheel =
    document.getElementById("fortuneWheel");

const wheelIssues =
    document.getElementById("wheelIssues");

const wheelIssueInput =
    document.getElementById("wheelIssueInput");

const addWheelIssueButton =
    document.getElementById("addWheelIssue");

const spinWheelButton =
    document.getElementById("spinWheel");

const wheelResult =
    document.getElementById("wheelResult");

const wheelStatus =
    document.getElementById("wheelStatus");

const defaultWheelIssues = [
    "Réviser les maths",
    "Avancer sur le projet",
    "Faire une pause"
];

let wheelIssueList = loadStorage(
    WHEEL_STORAGE_KEY,
    defaultWheelIssues
);

let wheelRotation = 0;
let wheelIsSpinning = false;


function saveWheelIssues() {

    saveStorage(
        WHEEL_STORAGE_KEY,
        wheelIssueList
    );

}


function renderWheel() {

    if (!fortuneWheel || !wheelIssues) {
        return;
    }

    const issueCount = wheelIssueList.length;

    if (issueCount) {

        const colors = [
            "#111111",
            "#d7d0c4",
            "#8d9a91",
            "#c8b6a6",
            "#66747a",
            "#e2d9ce"
        ];

        const segments = wheelIssueList
            .map((issue, index) => {
                const start =
                    (index / issueCount) * 100;

                const end =
                    ((index + 1) / issueCount) * 100;

                return `${colors[index % colors.length]} ${start}% ${end}%`;
            })
            .join(", ");

        fortuneWheel.style.background =
            `conic-gradient(${segments})`;

    } else {

        fortuneWheel.style.background = "#eeeeee";

    }

    wheelIssues.innerHTML = "";

    wheelIssueList.forEach((issue, index) => {

        const issueElement =
            document.createElement("div");

        issueElement.className = "wheel-issue";

        issueElement.innerHTML = `
            <span>${escapeHTML(issue)}</span>
            <button
                type="button"
                aria-label="Supprimer ${escapeHTML(issue)}"
                data-index="${index}"
            >
                ×
            </button>
        `;

        issueElement
            .querySelector("button")
            .addEventListener("click", () => {

                if (wheelIsSpinning) {
                    return;
                }

                wheelIssueList.splice(index, 1);
                saveWheelIssues();
                renderWheel();
                updateWheelControls();

            });

        wheelIssues.appendChild(issueElement);

    });

    updateWheelControls();

}


function updateWheelControls() {

    const canSpin =
        wheelIssueList.length >= 2 &&
        !wheelIsSpinning;

    if (spinWheelButton) {
        spinWheelButton.disabled = !canSpin;
    }

    if (addWheelIssueButton) {
        addWheelIssueButton.disabled = wheelIsSpinning;
    }

    if (wheelIssueInput) {
        wheelIssueInput.disabled = wheelIsSpinning;
    }

}


function addWheelIssue() {

    const issue =
        wheelIssueInput.value.trim();

    if (!issue || wheelIsSpinning) {
        return;
    }

    wheelIssueList.push(issue);
    saveWheelIssues();
    wheelIssueInput.value = "";
    renderWheel();
    wheelIssueInput.focus();

}


function spinFortuneWheel() {

    if (
        wheelIsSpinning ||
        wheelIssueList.length < 2
    ) {
        return;
    }

    wheelIsSpinning = true;
    updateWheelControls();

    const selectedIndex =
        Math.floor(
            Math.random() * wheelIssueList.length
        );

    const segmentAngle =
        360 / wheelIssueList.length;

    const targetAngle =
        360 - ((selectedIndex + 0.5) * segmentAngle);

    wheelRotation +=
        360 * 5 +
        targetAngle -
        (wheelRotation % 360);

    fortuneWheel.style.setProperty(
        "--wheel-rotation",
        `${wheelRotation}deg`
    );

    wheelStatus.textContent = "LA ROUE TOURNE...";
    wheelResult.textContent = "Le hasard décide";

    setTimeout(() => {

        wheelIsSpinning = false;
        wheelStatus.textContent = "RÉSULTAT";
        wheelResult.textContent =
            wheelIssueList[selectedIndex];
        updateWheelControls();

    }, 4200);

}


if (addWheelIssueButton) {
    addWheelIssueButton.addEventListener(
        "click",
        addWheelIssue
    );
}

if (wheelIssueInput) {
    wheelIssueInput.addEventListener(
        "keydown",
        event => {
            if (event.key === "Enter") {
                event.preventDefault();
                addWheelIssue();
            }
        }
    );
}

if (spinWheelButton) {
    spinWheelButton.addEventListener(
        "click",
        spinFortuneWheel
    );
}

renderWheel();

/* =========================================================
   WORK UP — TOP 3 DU JOUR
   ========================================================= */

const PRIORITIES_STORAGE_KEY = "workUpDailyPriorities";

const prioritiesForm =
    document.getElementById("prioritiesForm");

const priorityInput =
    document.getElementById("priorityInput");

const prioritiesList =
    document.getElementById("prioritiesList");

const prioritiesProgress =
    document.getElementById("prioritiesProgress");

const resetPrioritiesButton =
    document.getElementById("resetPriorities");

const todayPriorityKey =
    getFocusDateKey();

let dailyPriorities =
    loadStorage(
        PRIORITIES_STORAGE_KEY,
        {
            date: todayPriorityKey,
            items: []
        }
    );

if (
    dailyPriorities.date !== todayPriorityKey ||
    !Array.isArray(dailyPriorities.items)
) {
    dailyPriorities = {
        date: todayPriorityKey,
        items: []
    };
}


function saveDailyPriorities() {

    saveStorage(
        PRIORITIES_STORAGE_KEY,
        dailyPriorities
    );

}


function renderDailyPriorities() {

    if (!prioritiesList) {
        return;
    }

    prioritiesList.innerHTML = "";

    dailyPriorities.items.forEach(
        (priority, index) => {

            const item =
                document.createElement("label");

            item.className =
                "priority-item";

            item.classList.toggle(
                "is-complete",
                priority.done
            );

            item.innerHTML = `
                <input
                    type="checkbox"
                    ${priority.done ? "checked" : ""}
                    aria-label="Terminer ${escapeHTML(priority.text)}"
                >
                <span>${escapeHTML(priority.text)}</span>
                <button
                    type="button"
                    aria-label="Supprimer ${escapeHTML(priority.text)}"
                >
                    ×
                </button>
            `;

            item
                .querySelector("input")
                .addEventListener(
                    "change",
                    event => {
                        dailyPriorities.items[index].done =
                            event.target.checked;

                        saveDailyPriorities();
                        renderDailyPriorities();
                    }
                );

            item
                .querySelector("button")
                .addEventListener(
                    "click",
                    event => {
                        event.preventDefault();
                        dailyPriorities.items.splice(index, 1);
                        saveDailyPriorities();
                        renderDailyPriorities();
                        updatePrioritiesProgress();
                    }
                );

            prioritiesList.appendChild(item);

        }
    );

    updatePrioritiesProgress();

}


function updatePrioritiesProgress() {

    const completedCount =
        dailyPriorities.items.filter(
            priority => priority.done
        ).length;

    if (prioritiesProgress) {
        prioritiesProgress.textContent =
            `${completedCount} / ${dailyPriorities.items.length}`;
    }

    if (priorityInput) {
        priorityInput.disabled =
            dailyPriorities.items.length >= 3;
    }

}


if (prioritiesForm) {
    prioritiesForm.addEventListener(
        "submit",
        event => {
            event.preventDefault();

            const text =
                priorityInput.value.trim();

            if (
                !text ||
                dailyPriorities.items.length >= 3
            ) {
                return;
            }

            dailyPriorities.items.push({
                text,
                done: false
            });

            saveDailyPriorities();
            priorityInput.value = "";
            renderDailyPriorities();
            priorityInput.focus();
        }
    );
}


if (resetPrioritiesButton) {
    resetPrioritiesButton.addEventListener(
        "click",
        () => {
            dailyPriorities.items = [];
            saveDailyPriorities();
            renderDailyPriorities();
            priorityInput.focus();
        }
    );
}

renderDailyPriorities();

/* =========================================================
   WORK UP — INBOX RAPIDE
   ========================================================= */

const INBOX_STORAGE_KEY = "workUpQuickInbox";

const inboxForm =
    document.getElementById("inboxForm");

const inboxInput =
    document.getElementById("inboxInput");

const inboxList =
    document.getElementById("inboxList");

const inboxCount =
    document.getElementById("inboxCount");

const clearInboxButton =
    document.getElementById("clearInbox");

let inboxItems = loadStorage(
    INBOX_STORAGE_KEY,
    []
);


function saveInbox() {

    saveStorage(
        INBOX_STORAGE_KEY,
        inboxItems
    );

}


function renderInbox() {

    if (!inboxList) {
        return;
    }

    inboxList.innerHTML = "";

    inboxItems.forEach(
        (item, index) => {

            const element =
                document.createElement("div");

            element.className = "inbox-item";

            element.innerHTML = `
                <span>${escapeHTML(item)}</span>
                <button
                    type="button"
                    aria-label="Supprimer ${escapeHTML(item)}"
                >
                    ×
                </button>
            `;

            element
                .querySelector("button")
                .addEventListener(
                    "click",
                    () => {
                        inboxItems.splice(index, 1);
                        saveInbox();
                        renderInbox();
                    }
                );

            inboxList.appendChild(element);

        }
    );

    if (inboxCount) {
        inboxCount.textContent =
            `${inboxItems.length} ${
                inboxItems.length > 1
                    ? "idées"
                    : "idée"
            }`;
    }

    if (clearInboxButton) {
        clearInboxButton.disabled =
            inboxItems.length === 0;
    }

}


if (inboxForm) {
    inboxForm.addEventListener(
        "submit",
        event => {
            event.preventDefault();

            const item = inboxInput.value.trim();

            if (!item) {
                inboxInput.focus();
                return;
            }

            inboxItems.unshift(item);
            saveInbox();
            inboxInput.value = "";
            renderInbox();
            inboxInput.focus();
        }
    );
}


if (clearInboxButton) {
    clearInboxButton.addEventListener(
        "click",
        () => {
            inboxItems = [];
            saveInbox();
            renderInbox();
            inboxInput.focus();
        }
    );
}

renderInbox();

/* =========================================================
   WORK UP — PLANNING
   ========================================================= */

const PLANNING_STORAGE_KEY = "workUpPlanningEvents";

let planningEvents = loadStorage(
    PLANNING_STORAGE_KEY,
    []
);

let planningCurrentWeek = new Date();

/*
 * ID de l'événement actuellement sélectionné
 */
let planningSelectedEventId = null;

/*
 * ID conservé pendant une modification/suppression.
 * Important : le menu peut se fermer sans perdre l'ID.
 */
let planningEditingEventId = null;
let planningPendingDeleteId = null;


/* =========================================================
   ÉLÉMENTS HTML
   ========================================================= */

const planningView =
    document.getElementById("planningView");

const openPlanningModalButton =
    document.getElementById("openPlanningModal");

const planningModalOverlay =
    document.getElementById("planningModalOverlay");

const closePlanningModalButton =
    document.getElementById("closePlanningModal");

const cancelPlanningModalButton =
    document.getElementById("cancelPlanningModal");

const planningEventForm =
    document.getElementById("planningEventForm");

const planningEventName =
    document.getElementById("planningEventName");

const planningEventDate =
    document.getElementById("planningEventDate");

const planningEventStart =
    document.getElementById("planningEventStart");

const planningEventEnd =
    document.getElementById("planningEventEnd");

const planningEventDescription =
    document.getElementById("planningEventDescription");

const previousPlanningWeek =
    document.getElementById("previousPlanningWeek");

const nextPlanningWeek =
    document.getElementById("nextPlanningWeek");

const planningToday =
    document.getElementById("planningToday");

const planningWeekTitle =
    document.getElementById("planningWeekTitle");

const planningTimeLabels =
    document.getElementById("planningTimeLabels");

const planningDays =
    document.getElementById("planningDays");

const planningEventList =
    document.getElementById("planningEventList");

const planningEventCount =
    document.getElementById("planningEventCount");

const planningEmpty =
    document.getElementById("planningEmpty");


/* =========================================================
   MENU ÉVÉNEMENT
   ========================================================= */

const planningEventMenu =
    document.getElementById("planningEventMenu");

const planningRenameEvent =
    document.getElementById("planningRenameEvent");

const planningDeleteEvent =
    document.getElementById("planningDeleteEvent");


/* =========================================================
   MODALE RENOMMER
   ========================================================= */

const planningRenameOverlay =
    document.getElementById("planningRenameOverlay");

const planningRenameInput =
    document.getElementById("planningRenameInput");

const closePlanningRename =
    document.getElementById("closePlanningRename");

const cancelPlanningRename =
    document.getElementById("cancelPlanningRename");

const savePlanningRename =
    document.getElementById("savePlanningRename");


/* =========================================================
   MODALE SUPPRESSION
   ========================================================= */

const planningDeleteOverlay =
    document.getElementById("planningDeleteOverlay");

const planningDeleteMessage =
    document.getElementById("planningDeleteMessage");

const closePlanningDelete =
    document.getElementById("closePlanningDelete");

const cancelPlanningDelete =
    document.getElementById("cancelPlanningDelete");

const confirmPlanningDelete =
    document.getElementById("confirmPlanningDelete");


/* =========================================================
   VÉRIFICATION
   ========================================================= */

if (!planningView) {
    console.warn(
        "Planning : #planningView introuvable."
    );
}


/* =========================================================
   DATES
   ========================================================= */

function planningStartOfWeek(date) {

    const result = new Date(date);

    result.setHours(
        0,
        0,
        0,
        0
    );

    const day = result.getDay();

    const difference =
        day === 0
            ? -6
            : 1 - day;

    result.setDate(
        result.getDate() + difference
    );

    return result;
}


function planningFormatDateKey(date) {

    const year =
        date.getFullYear();

    const month =
        String(
            date.getMonth() + 1
        ).padStart(2, "0");

    const day =
        String(
            date.getDate()
        ).padStart(2, "0");

    return `${year}-${month}-${day}`;
}


function planningParseDateTime(
    date,
    time
) {

    return new Date(
        `${date}T${time}`
    );
}


function planningFormatDayName(date) {

    return date
        .toLocaleDateString(
            "fr-FR",
            {
                weekday: "short"
            }
        )
        .replace(".", "");
}


function planningFormatLongDate(date) {

    return date.toLocaleDateString(
        "fr-FR",
        {
            weekday: "long",
            day: "numeric",
            month: "long"
        }
    );
}


/* =========================================================
   NAVIGATION
   ========================================================= */

function changePlanningWeek(amount) {

    planningCurrentWeek =
        new Date(
            planningCurrentWeek
        );

    planningCurrentWeek.setDate(
        planningCurrentWeek.getDate() +
        amount * 7
    );

    renderPlanning();
}


function goToPlanningToday() {

    planningCurrentWeek =
        new Date();

    renderPlanning();
}


if (previousPlanningWeek) {

    previousPlanningWeek.addEventListener(
        "click",
        () => {
            changePlanningWeek(-1);
        }
    );

}


if (nextPlanningWeek) {

    nextPlanningWeek.addEventListener(
        "click",
        () => {
            changePlanningWeek(1);
        }
    );

}


if (planningToday) {

    planningToday.addEventListener(
        "click",
        goToPlanningToday
    );

}


/* =========================================================
   TITRE SEMAINE
   ========================================================= */

function renderPlanningWeekTitle() {

    const monday =
        planningStartOfWeek(
            planningCurrentWeek
        );

    const sunday =
        new Date(monday);

    sunday.setDate(
        sunday.getDate() + 6
    );


    const mondayText =
        monday.toLocaleDateString(
            "fr-FR",
            {
                day: "numeric",
                month: "long"
            }
        );


    const sundayText =
        sunday.toLocaleDateString(
            "fr-FR",
            {
                day: "numeric",
                month: "long",
                year: "numeric"
            }
        );


    if (planningWeekTitle) {

        planningWeekTitle.textContent =
            `${mondayText} — ${sundayText}`;

    }

}


/* =========================================================
   HORAIRES
   ========================================================= */

function renderPlanningTimeLabels() {

    if (!planningTimeLabels) {
        return;
    }

    planningTimeLabels.innerHTML = "";

    for (
        let hour = 7;
        hour <= 16;
        hour++
    ) {

        const label =
            document.createElement("div");

        label.className =
            "planning-time-label";

        label.textContent =
            `${String(hour).padStart(2, "0")}:00`;

        label.style.top =
            `${(hour - 7) * 60}px`;

        planningTimeLabels.appendChild(
            label
        );

    }

}


/* =========================================================
   CALENDRIER
   ========================================================= */

function renderPlanningCalendar() {

    if (!planningDays) {
        return;
    }

    planningDays.innerHTML = "";

    const monday =
        planningStartOfWeek(
            planningCurrentWeek
        );


    for (
        let dayIndex = 0;
        dayIndex < 7;
        dayIndex++
    ) {

        const date =
            new Date(monday);

        date.setDate(
            monday.getDate() +
            dayIndex
        );


        const dateKey =
            planningFormatDateKey(
                date
            );


        /* =========================
           JOUR
        ========================= */

        const day =
            document.createElement("div");

        day.className =
            "planning-day";


        if (
            dateKey ===
            planningFormatDateKey(
                new Date()
            )
        ) {

            day.classList.add(
                "today"
            );

        }


        /* =========================
           HEADER
        ========================= */

        const header =
            document.createElement("div");

        header.className =
            "planning-day-header";


        const dayName =
            document.createElement("span");

        dayName.className =
            "planning-day-name";

        dayName.textContent =
            planningFormatDayName(
                date
            );


        const dayNumber =
            document.createElement("span");

        dayNumber.className =
            "planning-day-number";

        dayNumber.textContent =
            date.getDate();


        header.appendChild(
            dayName
        );

        header.appendChild(
            dayNumber
        );


        /* =========================
           GRILLE
        ========================= */

        const grid =
            document.createElement("div");

        grid.className =
            "planning-hour-grid";


        /*
         * On récupère uniquement
         * les événements de ce jour.
         */

        const dayEvents =
            planningEvents.filter(
                event =>
                    event.date === dateKey
            );


        dayEvents.forEach(
            event => {

                renderPlanningEvent(
                    grid,
                    event
                );

            }
        );


        day.appendChild(
            header
        );

        day.appendChild(
            grid
        );

        planningDays.appendChild(
            day
        );

    }

}


/* =========================================================
   ÉVÉNEMENT DANS LE CALENDRIER
   ========================================================= */

function renderPlanningEvent(
    container,
    event
) {

    const start =
        planningParseDateTime(
            event.date,
            event.start
        );

    const end =
        planningParseDateTime(
            event.date,
            event.end
        );


    /*
     * Le calendrier commence à 07:00.
     */

    const calendarStart =
        planningParseDateTime(
            event.date,
            "07:00"
        );


    /*
     * 1 minute = 1 pixel.
     * Donc :
     * 07:00 = 0px
     * 08:00 = 60px
     * 09:00 = 120px
     */

    const top =
        Math.max(
            0,
            (start - calendarStart) / 60000
        );


    const duration =
        Math.max(
            30,
            (end - start) / 60000
        );


    const element =
        document.createElement("div");

    element.className =
        "planning-event";


    element.style.top =
        `${top}px`;

    element.style.height =
        `${duration}px`;


    element.innerHTML = `

        <div class="planning-event-title">
            ${escapeHTML(event.name)}
        </div>

        <div class="planning-event-time">
            ${event.start} — ${event.end}
        </div>

    `;


    /*
     * Clic gauche
     */

    element.addEventListener(
        "click",
        eventClick => {

            eventClick.stopPropagation();

            openPlanningEventMenu(
                event,
                eventClick.clientX,
                eventClick.clientY
            );

        }
    );


    /*
     * Clic droit
     */

    element.addEventListener(
        "contextmenu",
        eventClick => {

            eventClick.preventDefault();
            eventClick.stopPropagation();

            openPlanningEventMenu(
                event,
                eventClick.clientX,
                eventClick.clientY
            );

        }
    );


    container.appendChild(
        element
    );

}


/* =========================================================
   MENU ÉVÉNEMENT
   ========================================================= */

function openPlanningEventMenu(
    event,
    x,
    y
) {

    if (!planningEventMenu) {
        return;
    }


    planningSelectedEventId =
        event.id;


    /*
     * On positionne le menu
     * à l'endroit du clic.
     */

    planningEventMenu.style.left =
        `${x}px`;

    planningEventMenu.style.top =
        `${y}px`;


    planningEventMenu.classList.add(
        "is-visible"
    );

}


function closePlanningEventMenu() {

    if (!planningEventMenu) {
        return;
    }

    planningEventMenu.classList.remove(
        "is-visible"
    );

}


/* =========================================================
   RENOMMER
   ========================================================= */

function openPlanningRenameModal() {

    const event =
        planningEvents.find(
            item =>
                item.id ===
                planningSelectedEventId
        );


    if (!event) {
        return;
    }


    /*
     * On garde l'ID séparément.
     * Ainsi la fermeture du menu
     * ne le détruit pas.
     */

    planningEditingEventId =
        event.id;


    if (planningRenameInput) {

        planningRenameInput.value =
            event.name;

    }


    closePlanningEventMenu();


    if (planningRenameOverlay) {

        planningRenameOverlay.classList.add(
            "is-open"
        );

    }


    setTimeout(
        () => {

            if (planningRenameInput) {
                planningRenameInput.focus();
                planningRenameInput.select();
            }

        },
        50
    );

}


function closePlanningRenameModal() {

    if (!planningRenameOverlay) {
        return;
    }

    planningRenameOverlay.classList.remove(
        "is-open"
    );

    planningEditingEventId =
        null;

}


function savePlanningRenameValue() {

    if (!planningEditingEventId) {
        return;
    }


    const event =
        planningEvents.find(
            item =>
                item.id ===
                planningEditingEventId
        );


    if (!event) {
        return;
    }


    const newName =
        planningRenameInput.value.trim();


    if (!newName) {

        planningRenameInput.focus();

        return;

    }


    event.name =
        newName;


    saveStorage(
        PLANNING_STORAGE_KEY,
        planningEvents
    );


    closePlanningRenameModal();

    renderPlanning();

}


if (planningRenameEvent) {

    planningRenameEvent.addEventListener(
        "click",
        openPlanningRenameModal
    );

}


if (closePlanningRename) {

    closePlanningRename.addEventListener(
        "click",
        closePlanningRenameModal
    );

}


if (cancelPlanningRename) {

    cancelPlanningRename.addEventListener(
        "click",
        closePlanningRenameModal
    );

}


if (savePlanningRename) {

    savePlanningRename.addEventListener(
        "click",
        savePlanningRenameValue
    );

}


/* =========================================================
   SUPPRESSION
   ========================================================= */

function openPlanningDeleteModal() {

    const event =
        planningEvents.find(
            item =>
                item.id ===
                planningSelectedEventId
        );


    if (!event) {
        return;
    }


    /*
     * Même principe que pour le renommage :
     * on conserve l'ID séparément.
     */

    planningPendingDeleteId =
        event.id;


    if (planningDeleteMessage) {

        planningDeleteMessage.textContent =
            `Tu es sur le point de supprimer « ${event.name} ». Cette action est définitive.`;

    }


    closePlanningEventMenu();


    if (planningDeleteOverlay) {

        planningDeleteOverlay.classList.add(
            "is-open"
        );

    }

}


function closePlanningDeleteModal() {

    if (!planningDeleteOverlay) {
        return;
    }

    planningDeleteOverlay.classList.remove(
        "is-open"
    );

    planningPendingDeleteId =
        null;

}


function deleteSelectedPlanningEvent() {

    if (!planningPendingDeleteId) {
        return;
    }


    const eventId =
        planningPendingDeleteId;


    planningEvents =
        planningEvents.filter(
            event =>
                event.id !== eventId
        );


    saveStorage(
        PLANNING_STORAGE_KEY,
        planningEvents
    );


    planningSelectedEventId =
        null;

    planningPendingDeleteId =
        null;


    if (planningDeleteOverlay) {

        planningDeleteOverlay.classList.remove(
            "is-open"
        );

    }


    renderPlanning();

}


if (planningDeleteEvent) {

    planningDeleteEvent.addEventListener(
        "click",
        openPlanningDeleteModal
    );

}


if (closePlanningDelete) {

    closePlanningDelete.addEventListener(
        "click",
        closePlanningDeleteModal
    );

}


if (cancelPlanningDelete) {

    cancelPlanningDelete.addEventListener(
        "click",
        closePlanningDeleteModal
    );

}


if (confirmPlanningDelete) {

    confirmPlanningDelete.addEventListener(
        "click",
        deleteSelectedPlanningEvent
    );

}


/* =========================================================
   FERMETURE DU MENU EN CLIQUANT AILLEURS
   ========================================================= */

document.addEventListener(
    "click",
    event => {

        if (
            planningEventMenu &&
            planningEventMenu.classList.contains(
                "is-visible"
            ) &&
            !planningEventMenu.contains(event.target)
        ) {

            closePlanningEventMenu();

        }

    }
);


/* =========================================================
   CRÉATION D'UN ÉVÉNEMENT
   ========================================================= */

function openPlanningCreationModal() {
    planningModalOverlay.classList.add(
        "is-open"
    );


    planningEventDate.value =
        planningFormatDateKey(
            new Date()
        );

    planningEventStart.value =
        "17:00";

    planningEventEnd.value =
        "18:00";

    planningEventName.value =
        "";

    planningEventDescription.value =
        "";


    setTimeout(
        () => {

            if (planningEventName) {
                planningEventName.focus();
            }

        },
        50
    );

}


function closePlanningCreationModal() {

    if (!planningModalOverlay) {
        return;
    }

    planningModalOverlay.classList.remove(
        "is-open"
    );

}


if (openPlanningModalButton) {

    openPlanningModalButton.addEventListener(
        "click",
        openPlanningCreationModal
    );

}


if (closePlanningModalButton) {

    closePlanningModalButton.addEventListener(
        "click",
        closePlanningCreationModal
    );

}


if (cancelPlanningModalButton) {

    cancelPlanningModalButton.addEventListener(
        "click",
        closePlanningCreationModal
    );

}


/* =========================================================
   CRÉATION
   ========================================================= */

if (planningEventForm) {

    planningEventForm.addEventListener(
        "submit",
        event => {

            event.preventDefault();


            const name =
                planningEventName.value.trim();

            const date =
                planningEventDate.value;

            const start =
                planningEventStart.value;

            const end =
                planningEventEnd.value;

            const description =
                planningEventDescription.value.trim();


            if (
                !name ||
                !date ||
                !start ||
                !end
            ) {

                return;

            }


            /*
             * L'heure de fin doit être
             * après l'heure de début.
             */

            if (end <= start) {

                planningEventEnd.focus();

                return;

            }


            const newEvent = {

                id:
                    `planning-${Date.now()}-${Math.random()
                        .toString(36)
                        .slice(2, 9)}`,

                name,

                date,

                start,

                end,

                description

            };


            planningEvents.push(
                newEvent
            );


            saveStorage(
                PLANNING_STORAGE_KEY,
                planningEvents
            );


            /*
             * On affiche directement
             * la semaine de l'événement créé.
             */

            planningCurrentWeek =
                planningParseDateTime(
                    date,
                    start
                );


            closePlanningCreationModal();

            renderPlanning();

        }
    );

}


/* =========================================================
   LISTE CHRONOLOGIQUE
   ========================================================= */

function renderPlanningUpcoming() {

    if (!planningEventList) {
        return;
    }


    planningEventList.innerHTML =
        "";


    const sortedEvents =
        [...planningEvents]
            .sort(
                (a, b) => {

                    const dateA =
                        planningParseDateTime(
                            a.date,
                            a.end
                        );

                    const dateB =
                        planningParseDateTime(
                            b.date,
                            b.end
                        );

                    return dateA - dateB;

                }
            );


    if (planningEventCount) {

        planningEventCount.textContent =
            `${sortedEvents.length} ${
                sortedEvents.length > 1
                    ? "événements"
                    : "événement"
            }`;

    }


    if (
        sortedEvents.length === 0
    ) {

        if (planningEmpty) {

            planningEmpty.style.display =
                "block";

        }

        return;

    }


    if (planningEmpty) {

        planningEmpty.style.display =
            "none";

    }


    sortedEvents.forEach(
        event => {

            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "planning-list-event";


            const date =
                planningParseDateTime(
                    event.date,
                    event.end
                );


            item.innerHTML = `

                <div class="planning-list-time">
                    ${escapeHTML(event.end)}
                </div>

                <div class="planning-list-content">

                    <div class="planning-list-title">
                        ${escapeHTML(event.name)}
                    </div>

                    <div class="planning-list-date">
                        ${escapeHTML(
                            planningFormatLongDate(date)
                        )}
                        ·
                        ${escapeHTML(event.start)}
                        →
                        ${escapeHTML(event.end)}
                    </div>

                </div>

                <div class="planning-list-deadline">
                    ${escapeHTML(
                        planningGetDeadlineText(date)
                    )}
                </div>

            `;


            item.addEventListener(
                "click",
                clickEvent => {

                    openPlanningEventMenu(
                        event,
                        clickEvent.clientX,
                        clickEvent.clientY
                    );

                }
            );


            planningEventList.appendChild(
                item
            );

        }
    );

}


/* =========================================================
   TEXTE ÉCHÉANCE
   ========================================================= */

function planningGetDeadlineText(
    date
) {

    const now =
        new Date();

    const difference =
        date - now;


    if (difference < 0) {

        return "Échéance dépassée";

    }


    const minutes =
        Math.floor(
            difference / 60000
        );


    if (minutes < 60) {

        return `Dans ${minutes} min`;

    }


    const hours =
        Math.floor(
            minutes / 60
        );


    if (hours < 24) {

        return `Dans ${hours}h`;

    }


    const days =
        Math.floor(
            hours / 24
        );


    return `Dans ${days}j`;

}


/* =========================================================
   RENDU GLOBAL
   ========================================================= */

function renderPlanning() {

    renderPlanningWeekTitle();

    renderPlanningTimeLabels();

    renderPlanningCalendar();

    renderPlanningUpcoming();

}


/* =========================================================
   ESCAPE HTML
   ========================================================= */

function escapeHTML(value) {

    const div =
        document.createElement(
            "div"
        );

    div.textContent =
        String(value ?? "");

    return div.innerHTML;

}


/* =========================================================
   ESCAPE
   ========================================================= */

document.addEventListener(
    "keydown",
    event => {

        if (event.key !== "Escape") {
            return;
        }


        /*
         * On ferme dans cet ordre.
         */

        if (
            planningRenameOverlay &&
            planningRenameOverlay.classList.contains(
                "is-open"
            )
        ) {

            closePlanningRenameModal();

            return;

        }


        if (
            planningDeleteOverlay &&
            planningDeleteOverlay.classList.contains(
                "is-open"
            )
        ) {

            closePlanningDeleteModal();

            return;

        }


        if (
            planningModalOverlay &&
            planningModalOverlay.classList.contains(
                "is-open"
            )
        ) {

            closePlanningCreationModal();

            return;

        }


        closePlanningEventMenu();

    }
);


/* =========================================================
   INITIALISATION
   ========================================================= */

renderPlanning();