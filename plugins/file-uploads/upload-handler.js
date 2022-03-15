/*\
title: $:/plugins/commons/file-uploads/uploadhandler.js
type: application/javascript
module-type: global
The upload handler manages uploading binary tiddlers to external storage.
\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

UploadHandler.prototype.titleFileUploadFilter = "$:/config/fileUploadFilter";
UploadHandler.prototype.titleUploader = "$:/config/fileUploader";
UploadHandler.prototype.titleUploadedNotification = "$:/plugins/commons/file-uploads/Notifications/Uploaded";
UploadHandler.prototype.titleUploadingNotification = "$:/plugins/commons/file-uploads/Notifications/Uploading";
UploadHandler.prototype.titleUploadsEnabled = "$:/config/fileUploads/uploadsEnabled";

function UploadHandler(options) {
	var self = this;
	this.wiki = options.wiki;
	this.logger = new $tw.utils.Logger("upload-handler");
	this.options = options;

	var callback = function(err,nextCallback) {
		delete self.uploadTask;
		if(!err) {
			//self.logger.clearAlerts();
			$tw.notifier.display(self.titleUploadedNotification);
			if(nextCallback) {
				self.logger.log("checking for pending uploads");
				// Check if there are any new tiddlers that need to be uploaded
				$tw.utils.nextTick(nextCallback);
			}
		}
	};

	var runTask = function(uploadTask,nextCallback) {
		$tw.notifier.display(self.titleUploadingNotification,{variables:{
			count: uploadTask.taskTiddlers.length.toString()
		}});
		self.uploadTask = uploadTask;
		self.uploadTask.run(function(err){
			callback(err,nextCallback);
		});
	}

	$tw.rootWidget.addEventListener("tm-upload-tiddlers",function(event){
		var filter = event.param ||"",
			tiddlersToUpload = self.wiki.filterTiddlers(filter,$tw.rootWidget);
		if(!self.uploadTask) {
			var uploadTask = self.getUploadTask(tiddlersToUpload);
			if(uploadTask) {
				runTask(uploadTask);
			}
		} else {
			self.logger.alert("There is already an upload task in progress.");
		}
	});

	this.wiki.addEventListener("change",function(changes){
		var uploadsEnabled = self.wiki.getTiddlerText(self.titleUploadsEnabled,"yes").trim() === "yes";
		if(!uploadsEnabled) {
			return;
		}
		var upload = function() {
			var uploadFilter = self.wiki.getTiddlerText(self.titleFileUploadFilter),
				tiddlersToUpload = self.wiki.filterTiddlers(uploadFilter);
			if(tiddlersToUpload.length > 0) {
				// If we are not already uploading then start a new upload task
				// If an upload task is already in progress then new tiddlers that need to be uploaded will be picked up in the next task 
				if(!self.uploadTask) {
					// The tiddlers currently matching the upload filter are the paylaod for the upload task
					var uploadTask = self.getUploadTask(tiddlersToUpload);
					if(uploadTask) {
						runTask(uploadTask,upload);
					}
				}
			} else {
				self.logger.log("no pending uploads");
			}
		};
		// ToDo find a cleaner alternative for logging
		// Filter out alert tiddlers from changes otherwise the alerts we show keep triggering the change listener
		var changedTiddlers = [];
		$tw.utils.each(changes,function(change,title){
			var tiddler = self.wiki.tiddlerExists(title) && self.wiki.getTiddler(title);
			if(tiddler){
				changedTiddlers.push(title);
			}
		});
		var filteredChanges = self.wiki.filterTiddlers("[!prefix[$:/temp/alerts/alert]]",null,self.wiki.makeTiddlerIterator(changedTiddlers));
		if(filteredChanges.length > 0) {
			upload();
		}
	});

	$tw.addUnloadTask(function(event) {
		var confirmationMessage;
		if(self.isDirty()) {
			// Modern browsers do not use the specified string
			confirmationMessage = $tw.language.getString("UnsavedChangesWarning");
			event.returnValue = confirmationMessage; // Gecko			
		}
		return confirmationMessage;
	});
};

UploadHandler.prototype.getUploadTask = function(tiddlersToUpload) {
	var uploadTask = new UploadTask(tiddlersToUpload,{
		wiki: this.wiki,
		uploaderConfig: this.wiki.getTiddlerText(this.titleUploader,"").trim(),
		logger: this.logger
	});
	if(!uploadTask.uploader) {
		this.logger.alert("Please check the uploader configuration for the [[FileUploads|$:/plugins/commons/file-uploads]] plugin.");
		return null;
	} else {
		return uploadTask;
	}
};

UploadHandler.prototype.isDirty = function() {
	return !!this.uploadTask;
};

function UploadTask(tiddlers,options) {
	var self = this;
	this.wiki = options.wiki;
	this.taskTiddlers = tiddlers;
	this.tiddlerInfo = {};
	this.logger = options.logger;
	this.uploader = this.getUploader(options.uploaderConfig);
};

UploadTask.prototype.displayError = function(msg,err) {
	this.logger.alert(msg + ":",err);
};

UploadTask.prototype.run = function(uploadHandlerCallback){
	var self = this;
	self.uploader.initialize(function(err){
		if(err) {
			self.displayError("Error in uploader.initialize, aborting uploads");
			uploadHandlerCallback(err);
		} else {
			self.processTiddlerQueue(uploadHandlerCallback);
		}
	});
};

UploadTask.prototype.getUploader = function(uploaderName) {
	var uploader;
	$tw.modules.forEachModuleOfType("uploader",function(title,module) {
		if(module.name === uploaderName) {
			uploader = module;
		}
	});
	return uploader && uploader.create({logger:this.logger});
};

// Returns true if changeCount in tiddlerInfo is the same as the current changeCount of the tiddler
UploadTask.prototype.changeCountUnchanged = function(title) {
	var tiddler = this.wiki.getTiddler(title);
	if(tiddler && this.tiddlerInfo[title]) {
		var changeCount = this.wiki.getChangeCount(title);
		if(changeCount === this.tiddlerInfo[title].changeCount) {
			return true;
		}
	}
	return false;
};

// Converts a binary tiddler into a canonical_uri tiddler if:
// - the tiddler still exists
// - the tiddler has not changed since we uploaded it
UploadTask.prototype.makeCanonicalURITiddler = function(title) {
	var tiddler = this.wiki.getTiddler(title),
		canonical_uri = this.tiddlerInfo[title].canonical_uri,
		fields = this.tiddlerInfo[title].fields;
	
	if(tiddler && canonical_uri && this.changeCountUnchanged(title)) {
		this.wiki.addTiddler(new $tw.Tiddler(tiddler,{text:"",_canonical_uri:canonical_uri},fields));
	} else {
		console.log("Could not convert " + title + " to a canonical_uri tiddler");
	}
};

UploadTask.prototype.processTiddlerQueue = function(uploadHandlerCallback) {
	var self = this,
		nextTiddlerIndex = 0;
	
	var deinitializeCallback = function(err,uploadInfoArray) {
		if(err) {
			self.displayError(err,"Error in uploader deinitialize");
			uploadHandlerCallback(err);
		} else {
			// Some uploaders may not have canonical_uris earlier and may pass an array of item objects with canonical_uri set
			$tw.utils.each(uploadInfoArray,function(uploadInfo){
				// For every uploaded tiddler save the canonical_uri and fields if one has been returned
				if(uploadInfo.uploadComplete && uploadInfo.canonical_uri && uploadInfo.title && self.tiddlerInfo[uploadInfo.title]) {
					self.tiddlerInfo[uploadInfo.title].canonical_uri = uploadInfo.canonical_uri;
					if(uploadInfo.fields) {
						self.tiddlerInfo[uploadInfo.title].fields = uploadInfo.fields;
					}
				}
			});
			// Convert all uploaded tiddlers for which we have a canonical_uri to canonical_uri tiddlers
			for(var title in self.tiddlerInfo) {
				self.makeCanonicalURITiddler(title);
			}
			delete self.uploader;
			self.tiddlerInfo = {};
			self.logger.log("uploader deinitialize callback");
			self.logger.log("Uploads completed");
			uploadHandlerCallback();
		}
	};
	
	var uploadedTiddlerCallback = function(err,uploadInfo) {
		if(err) {
			self.displayError("there was an error uploading " + uploadInfo.title + ", aborting uploads");
			uploadHandlerCallback(err);
		} else {
			self.logger.log("upload callback for " + uploadInfo.title);
			// Save the canonical_uri if one has been set
			if(uploadInfo.canonical_uri) {
				self.tiddlerInfo[uploadInfo.title].canonical_uri = uploadInfo.canonical_uri;
			}
			// Save the fields if one has been set
			if(uploadInfo.fields) {
				self.tiddlerInfo[uploadInfo.title].fields = uploadInfo.fields;
			}
			// If uploadComplete is true then convert the tiddler to a canonical_uri tiddler
			if(uploadInfo.uploadComplete) {
				self.makeCanonicalURITiddler(uploadInfo.title);
				delete self.tiddlerInfo[uploadInfo.title];
				//below line is for debugging only
				//self.wiki.setText(item.title,"upload-status",null,"uploaded");
			}			
			nextTiddlerIndex++;
			uploadNextTiddler();
		}
	};
	
	var uploadNextTiddler = function() {
		var title,
			tiddler;
		// Skip over any queued tiddlers that might have been deleted
		while(nextTiddlerIndex < self.taskTiddlers.length && !tiddler) {
			title = self.taskTiddlers[nextTiddlerIndex];
			tiddler = self.wiki.getTiddler(title);
			if(!tiddler) {
				nextTiddlerIndex++;
			}
		}
		if(tiddler) {
			self.tiddlerInfo[title] = {
				changeCount : self.wiki.getChangeCount(title)
			}
			var uploadItem = self.getTiddlerUploadItem(tiddler);
			self.uploader.uploadFile(uploadItem,function(err,uploadItemInfo){
				$tw.utils.nextTick(function(){uploadedTiddlerCallback(err,uploadItemInfo)});
			});
		} else {
			self.uploader.deinitialize(deinitializeCallback);
		}
	};
	uploadNextTiddler();
};

UploadTask.prototype.getTiddlerUploadItem = function(tiddler) {
	//	TODO:
		// Need to sanitize tiddler titles to make sure they are valid file names
		// file names must be unique or we could overwrite the file corresponding to another uploaded tiddler.
	return new UploadItem(tiddler);
}

function UploadItem(tiddler) {
	this.title = tiddler.fields.title;
	this.filename = tiddler.fields.title;
	this.text = tiddler.fields.text || "";
	this.type = tiddler.fields.type || "text/vnd.tiddlywiki";
	this.isBase64 = ($tw.config.contentTypeInfo[tiddler.fields.type] || {}).encoding  === "base64";
};

UploadItem.prototype.getUint8Array = function() {
	var byteCharacters = atob(this.text),
		byteArray = new Uint8Array(byteCharacters.length);
	for(var i=0; i < byteCharacters.length; i++) {
		byteArray[i] = byteCharacters.charCodeAt(i);
	}
	return byteArray;	
};

UploadItem.prototype.getBlob = function() {
	if(this.isBase64) {
		var byteArray = this.getUint8Array();
		return new Blob([byteArray], {type: this.type});		
	} else {
		return new Blob([this.text],{type: "text/plain"});
	}
};

exports.UploadHandler = UploadHandler;

})();
