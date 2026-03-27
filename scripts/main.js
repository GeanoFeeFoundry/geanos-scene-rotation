Hooks.on("renderSceneConfig", (app, html, data) => {
    const $html = $(html);
    let header = $html.find(".window-header");

    // ApplicationV2 Compatibility: If html is content, check app.element for the window header
    if (header.length === 0 && app.element) {
        header = $(app.element).find(".window-header");
    }

    if (header.length === 0) return; // Do not inject if no header found

    // Look for Close Button
    let closeBtn = header.find("[data-action='close']");
    if (closeBtn.length === 0) closeBtn = header.find(".close");

    // Prevent duplicate injection
    if (header.find("#geanos-rotate-btn").length > 0) return;

    // Create Rotate Button
    const rotateBtn = $(`<a class="control window-control" id="geanos-rotate-btn" data-action="rotate" data-tooltip="${game.i18n.localize("SCENEROTATION.RotateButton")}"><i class="fas fa-sync-alt"></i> ${game.i18n.localize("SCENEROTATION.RotateButton")}</a>`);

    if (closeBtn.length > 0) {
        rotateBtn.insertBefore(closeBtn);
    } else {
        // Fallback: Prepend to header to ensure visibility
        header.prepend(rotateBtn);
    }
    rotateBtn.on("click", async (event) => {
        event.preventDefault();

        const degrees = await foundry.applications.api.DialogV2.wait({
            window: { title: game.i18n.localize("SCENEROTATION.DialogTitle") },
            content: `<p>${game.i18n.localize("SCENEROTATION.DialogContent")}</p>`,
            buttons: [
                {
                    action: "clockwise",
                    label: game.i18n.localize("SCENEROTATION.Clockwise"),
                    default: true,
                    callback: () => 90,
                    icon: "fas fa-redo"
                },
                {
                    action: "counterClockwise",
                    label: game.i18n.localize("SCENEROTATION.CounterClockwise"),
                    callback: () => -90,
                    icon: "fas fa-undo"
                }
            ],
            close: () => null
        });

        if (degrees) {
            const scene = app.document;
            ui.notifications.info(`Rotating scene ${scene.name} by ${degrees} degrees...`);
            const rotator = new SceneRotator(scene);
            await rotator.rotate(degrees);
            ui.notifications.info("Rotation complete.");
        }
    });
});

class SceneRotator {
    constructor(scene) {
        this.scene = scene;
    }

    async rotate(degrees) {
        if (degrees % 90 !== 0) return;

        // Normalize degrees to 90 or -90 (or 180, 270 etc, but UI currently only sends 90/-90)
        // We will loop 90 degree turns if needed, but for now specific logic for 90/-90 is easier to reason about 
        // or just general formula.

        const oldWidth = this.scene.width;
        const oldHeight = this.scene.height;

        // Calculate new dimensions
        // For 90 or -90 (270), width and height swap.
        // For 180, they stay same.
        const isSwap = Math.abs(degrees) % 180 !== 0;
        const newWidth = isSwap ? oldHeight : oldWidth;
        const newHeight = isSwap ? oldWidth : oldHeight;

        // Coordinate Transform Function
        // 90 CW: (x, y) -> (H - y, x)
        // -90 CCW: (x, y) -> (y, W - x)
        // 180: (x, y) -> (W - x, H - y)

        const transform = (x, y) => {
            let nx = x, ny = y;
            // Handle 90 degree steps. For simplicity, let's just handle +90 and -90.
            if (degrees === 90 || degrees === -270) {
                nx = oldHeight - y;
                ny = x;
            } else if (degrees === -90 || degrees === 270) {
                nx = y;
                ny = oldWidth - x;
            } else if (Math.abs(degrees) === 180) {
                nx = oldWidth - x;
                ny = oldHeight - y;
            }
            return { x: nx, y: ny };
        };

        const updates = {}; // Atomic Update Object

        // 1. Scene Updates
        updates.width = newWidth;
        updates.height = newHeight;
        // 1.5 Background Offset Rotation
        const oldOffX = this.scene.background.offsetX || 0;
        const oldOffY = this.scene.background.offsetY || 0;

        // Calculate new offsets based on rotation
        // 90 CW: Top-Left of new image corresponds to Bottom-Left of old image relative to (0,0)
        // -90 CCW: Top-Left of new image corresponds to Top-Right of old image relative to (0,0)

        let newOffX = oldOffX;
        let newOffY = oldOffY;

        if (degrees === 90 || degrees === -270) {
            newOffX = -oldOffY;
            newOffY = oldOffX;
        } else if (degrees === -90 || degrees === 270) {
            newOffX = oldOffY;
            newOffY = -oldOffX;
        } else if (Math.abs(degrees) === 180) {
            newOffX = -oldOffX;
            newOffY = -oldOffY;
        }

        updates["background.offsetX"] = newOffX;
        updates["background.offsetY"] = newOffY;

        // 2. Embedded Documents
        // Atomic Update: Gather updates for all embedded documents into the main update object.
        // This prevents partial application where Tokens move but Scene doesn't rotate.

        // Docs to rotate: Token, Tile, Wall, AmbientLight, AmbientSound, Note, Drawing, MeasuredTemplate
        const embeddedTypes = [
            "Token", "Tile", "Wall", "AmbientLight", "AmbientSound", "Note", "Drawing", "MeasuredTemplate"
        ];

        // Map Type to Collection Name used in update (e.g. "Token" -> "tokens")
        const typeToCollection = {
            "Token": "tokens",
            "Tile": "tiles",
            "Wall": "walls",
            "AmbientLight": "lights",
            "AmbientSound": "sounds",
            "Note": "notes",
            "Drawing": "drawings",
            "MeasuredTemplate": "templates"
        };

        for (const type of embeddedTypes) {
            const collection = this.scene.getEmbeddedCollection(type);
            if (!collection.size) continue;

            const collectionKey = typeToCollection[type];
            if (!collectionKey) continue;

            const docUpdates = [];
            for (const doc of collection) {
                const update = { _id: doc.id };

                if (type === "Wall") {
                    const c = doc.c;
                    const p1 = transform(c[0], c[1]);
                    const p2 = transform(c[2], c[3]);
                    update.c = [p1.x, p1.y, p2.x, p2.y];
                }
                else if (type === "AmbientLight" || type === "AmbientSound" || type === "Note") {
                    const { x, y } = transform(doc.x, doc.y);
                    update.x = x;
                    update.y = y;
                    if (type === "AmbientLight" && doc.config?.rotation !== undefined) {
                        // Light rotation logic if applicable (e.g. cone)
                        update["config.rotation"] = (doc.config.rotation + degrees) % 360;
                    }
                }
                else if (type === "Token" || type === "Tile" || type === "Drawing") {
                    // Logic:
                    // 1. Calculate Original Center in PIXELS
                    // 2. Transform Center to New Coordinates
                    // 3. Determine New Width/Height (Swap if 90/270 deg rotation)
                    // 4. Calculate New Top-Left based on New Center and New Dimensions

                    let pixelW = 0, pixelH = 0;
                    let isToken = type === "Token";
                    let isTile = type === "Tile";
                    let isDrawing = type === "Drawing";

                    // Get Dimensions
                    if (isToken) {
                        // FIX: Use accurate pixel dimensions from the PlaceableObject (doc.object) if available.
                        // This handles Hex grids where `width * size` !== pixel width.
                        // Also handles other grid types/scaling correctly.
                        if (doc.object && doc.object.w && doc.object.h) {
                            pixelW = doc.object.w;
                            pixelH = doc.object.h;
                        } else {
                            // Fallback (Square Grid assumption)
                            pixelW = (doc.width || 0) * this.scene.grid.size;
                            pixelH = (doc.height || 0) * this.scene.grid.size;
                        }
                    } else if (isTile) {
                        pixelW = doc.width || 0;
                        pixelH = doc.height || 0;
                    } else if (isDrawing) {
                        pixelW = doc.shape.width || 0;
                        pixelH = doc.shape.height || 0;
                    }

                    // Original Top-Left
                    const ox = doc.x;
                    const oy = doc.y;

                    // Original Center
                    const cx = ox + pixelW / 2;
                    const cy = oy + pixelH / 2;

                    // New Center
                    const { x: ncx, y: ncy } = transform(cx, cy);

                    // Determine if we need to swap dimensions (90 or 270 degrees)
                    const is90Step = Math.abs(degrees) % 180 !== 0;

                    let newPixelW = pixelW;
                    let newPixelH = pixelH;

                    if (is90Step) {
                        // Swap dimensions for the calculation of Top-Left
                        newPixelW = pixelH;
                        newPixelH = pixelW;

                        // For non-square objects, we should also update the document's width/height properties?
                        if (isToken) {
                            update.width = doc.height;
                            update.height = doc.width;
                        } else if (isTile) {
                            update.width = doc.height;
                            update.height = doc.width;
                        } else if (isDrawing) {
                            update["shape.width"] = doc.shape.height;
                            update["shape.height"] = doc.shape.width;
                        }
                    }

                    // Calculate New Top-Left
                    // We use the NEW dimensions to center it on the NEW center point.
                    update.x = ncx - newPixelW / 2;
                    update.y = ncy - newPixelH / 2;

                    update.rotation = ((doc.rotation || 0) + degrees) % 360;
                }
                else if (type === "MeasuredTemplate") {
                    const { x, y } = transform(doc.x, doc.y);
                    update.x = x;
                    update.y = y;
                    update.direction = (doc.direction + degrees) % 360;
                }

                docUpdates.push(update);
            }

            if (docUpdates.length > 0) {
                updates[collectionKey] = docUpdates;
            }
        }

        // 3. Image Rotation (Background & Foreground)
        try {
            const imageRotator = new ImageRotator();

            if (this.scene.background.src) {
                ui.notifications.info("Rotating background image...");
                const newBg = await imageRotator.rotateAndUpload(this.scene.background.src, degrees, "image/jpeg");
                if (newBg) updates["background.src"] = newBg;
            }

            if (this.scene.foreground) {
                ui.notifications.info("Rotating foreground image...");
                const newFg = await imageRotator.rotateAndUpload(this.scene.foreground, degrees, "image/png");
                if (newFg) updates.foreground = newFg;
            }
        } catch (err) {
            console.error(err);
            ui.notifications.warn(`Image rotation failed: ${err.message}. Scene will rotate but background image might look wrong.`);
        }

        // 4. Hex Grid Rotation (Swap Rows <-> Columns)
        const gridType = this.scene.grid.type;
        if (gridType >= 2 && gridType <= 5 && isSwap) {
            let newType = gridType;
            if (gridType === 2) newType = 4;      // RowsOdd -> ColsOdd
            else if (gridType === 3) newType = 5; // RowsEven -> ColsEven
            else if (gridType === 4) newType = 2; // ColsOdd -> RowsOdd
            else if (gridType === 5) newType = 3; // ColsEven -> RowsEven

            updates["grid.type"] = newType;
            ui.notifications.info("Swapping Hex Grid orientation to match rotation.");
        }

        // 5. Fog of War Reset
        if (this.scene.fog.exploration) {
            ui.notifications.info("Resetting Fog of War to ensure alignment.");
            try {
                if (typeof this.scene.resetFog === "function") {
                    await this.scene.resetFog();
                } else if (this.scene.isView && canvas.fog) {
                    await canvas.fog.reset();
                } else {
                    console.warn("Geano's Rotation: Could not find a method to reset Fog of War for this scene.");
                }
                await new Promise(r => setTimeout(r, 100)); // Wait for reset
            } catch (err) {
                console.warn("Geano's Rotation: Failed to reset Fog of War.", err);
            }
        }

        // Final Atomic Update
        await this.scene.update(updates);
    }
}

class ImageRotator {
    async rotateAndUpload(path, degrees, mimeType = "image/jpeg") {
        if (!path) return null;

        // Map mime-type to extension
        const extMap = {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp"
        };
        const ext = extMap[mimeType] || "jpg";

        // --- 1. Determine Paths and Names ---
        const pathParts = path.split("/");
        const filename = pathParts.pop();
        const decodedFilename = decodeURIComponent(filename);
        let parentDir = decodeURIComponent(pathParts.join("/"));
        
        let baseName = decodedFilename.substring(0, decodedFilename.lastIndexOf(".")) || decodedFilename;
        let currentRotation = 0;

        // Regex to check for existing rotation
        const rotationMatch = baseName.match(/^(.*)_rotation(-?\d+)$/);

        if (rotationMatch) {
            baseName = rotationMatch[1];
            currentRotation = parseInt(rotationMatch[2], 10);
            if (parentDir.endsWith("/rotated-images") || parentDir.endsWith("rotated-images")) {
                // Do nothing
            } else {
                parentDir = parentDir ? `${parentDir}/rotated-images` : "rotated-images";
            }
        } else {
            parentDir = parentDir ? `${parentDir}/rotated-images` : "rotated-images";
        }

        // Calculate new rotation
        let newRotation = (currentRotation + degrees) % 360;
        if (newRotation < 0) newRotation += 360;

        const newFileName = `${baseName}_rotation${newRotation}.${ext}`;

        // --- 2. Check Existence ---
        try {
            const result = await foundry.applications.apps.FilePicker.browse("data", parentDir).catch(() => null);

            if (result) {
                const exists = result.files.find(f => decodeURIComponent(f).endsWith(newFileName));
                if (exists) {
                    return exists;
                }
            }
        } catch (e) {
            // Browse failed (maybe dir doesn't exist yet). Proceed to generate.
        }

        // --- 3. Render and Upload ---
        const img = await this._loadImage(path);

        const isSwap = Math.abs(degrees) % 180 !== 0;
        const width = isSwap ? img.height : img.width;
        const height = isSwap ? img.width : img.height;

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");

        ctx.translate(width / 2, height / 2);
        ctx.rotate(degrees * Math.PI / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);

        const exportBlob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, 0.9));

        try {
            await foundry.applications.apps.FilePicker.createDirectory("data", parentDir).catch(() => { });
        } catch (e) { }

        const file = new File([exportBlob], newFileName, { type: mimeType });
        const uploadResult = await foundry.applications.apps.FilePicker.upload("data", parentDir, file);

        return uploadResult.path;
    }

    _loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }
}
